// agentXchange on Azure: one container (Container Apps) plus where it keeps its data.
//
// database = 'pglite'   (default) the app runs its embedded PostgreSQL (PGlite) and keeps the files on an
//                       Azure Files share mounted into the container. Almost free, but for demo data only.
// database = 'postgres' a small Azure Database for PostgreSQL server, reached through DATABASE_URL.
//
// Deploy in two passes (see README):
//   1. without "image": creates the registry, data store and environment
//   2. with "image":    creates the app itself, once the image has been pushed to the registry

@description('Short lowercase name used for every resource, e.g. agentxchange')
@minLength(3)
@maxLength(16)
param name string = 'agentxchange'

param location string = resourceGroup().location

@description('Full image reference, e.g. agentxchangeacr1234.azurecr.io/agentxchange:v1. Leave empty on the first pass.')
param image string = ''

@description('Where the app keeps its data: pglite (embedded, on a file share) or postgres (managed server).')
@allowed(['pglite', 'postgres'])
param database string = 'pglite'

param dbUser string = 'agentxchange'

@secure()
@description('Database password (postgres mode only). Use letters and digits only so it is safe inside a connection string.')
param dbPassword string = ''

var suffix = uniqueString(resourceGroup().id)
var usePostgres = database == 'postgres'
var dataDir = '/home/node/data'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${name}${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: true }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}

// ---------- pglite mode: a file share for the embedded database ----------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (!usePostgres) {
  name: take('${name}${suffix}', 24)
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: { minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true }

  resource fileService 'fileServices' = {
    name: 'default'

    resource share 'shares' = {
      name: 'pglite'
      properties: { shareQuota: 5 }
    }
  }
}

resource dataStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = if (!usePostgres) {
  parent: environment
  name: 'pglite'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage!.listKeys().keys[0].value
      shareName: storage::fileService::share.name
      accessMode: 'ReadWrite'
    }
  }
}

// ---------- postgres mode: a managed server ----------

resource db 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = if (usePostgres) {
  name: '${name}-db-${suffix}'
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: dbUser
    administratorLoginPassword: dbPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7 }
  }

  resource database 'databases' = {
    name: 'agentxchange'
  }

  // The special 0.0.0.0 rule means "allow connections from inside Azure", which is how the app reaches it.
  resource allowAzure 'firewallRules' = {
    name: 'AllowAzureServices'
    properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
  }
}

// ---------- the app ----------

var registrySecret = { name: 'registry-password', value: registry.listCredentials().passwords[0].value }

resource app 'Microsoft.App/containerApps@2024-03-01' = if (!empty(image)) {
  name: name
  location: location
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: { external: true, targetPort: 3000, allowInsecure: false }
      registries: [
        { server: registry.properties.loginServer, username: registry.listCredentials().username, passwordSecretRef: 'registry-password' }
      ]
      secrets: usePostgres
        ? [
            registrySecret
            {
              name: 'database-url'
              value: 'postgresql://${dbUser}:${dbPassword}@${db!.properties.fullyQualifiedDomainName}:5432/agentxchange?sslmode=require'
            }
          ]
        : [registrySecret]
    }
    template: {
      containers: [
        {
          name: 'agentxchange'
          image: image
          // PGlite builds its database in memory on first start (about 1.2 GB at peak, ~450 MB after), so
          // pglite mode needs the 1 vCPU / 2 GiB size; with a managed server the smallest size is enough.
          resources: usePostgres ? { cpu: json('0.25'), memory: '0.5Gi' } : { cpu: json('1.0'), memory: '2Gi' }
          env: usePostgres ? [{ name: 'DATABASE_URL', secretRef: 'database-url' }] : [{ name: 'DATA_DIR', value: dataDir }]
          volumeMounts: usePostgres ? [] : [{ volumeName: 'data', mountPath: dataDir }]
          probes: [{ type: 'Liveness', httpGet: { path: '/healthz', port: 3000 } }]
        }
      ]
      // The node user in the image is uid/gid 1000. PostgreSQL wants its data folder private (0700) and owned
      // by the user it runs as; nobrl stops SMB byte-range locks, which databases on a file share trip over.
      volumes: usePostgres
        ? []
        : [
            {
              name: 'data'
              storageType: 'AzureFile'
              storageName: dataStorage.name
              mountOptions: 'uid=1000,gid=1000,dir_mode=0700,file_mode=0600,nobrl'
            }
          ]
      // Exactly one copy at most: turn-taking is coordinated inside a single process, and with pglite only one
      // process may open the database files.
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output url string = empty(image) ? '' : 'https://${app!.properties.configuration.ingress.fqdn}'
