#!/usr/bin/env bash
# Deploys agentXchange to Azure: one container app plus where it keeps its data.
#
#   ./scripts/deploy-azure.sh            first deploy, or a re-deploy of new code
#
# Optional settings (environment variables):
#   AGENTXCHANGE_GROUP        resource group name          (default: agentxchange)
#   AGENTXCHANGE_LOCATION     Azure region                 (default: westus3)
#   AGENTXCHANGE_NAME         short lowercase name prefix  (default: agentxchange)
#   AGENTXCHANGE_DATABASE     pglite or postgres           (default: pglite)
#                             pglite: embedded database on an Azure file share, demo data only
#                             postgres: a managed Azure Database for PostgreSQL server
#   AGENTXCHANGE_DB_PASSWORD  database password, postgres only (asked for if not set)
#   AGENTXCHANGE_YES=1        skip the confirmation question
#
# Safe to run again after a failure: every step updates what already exists.
set -euo pipefail
cd "$(dirname "$0")/.."

GROUP="${AGENTXCHANGE_GROUP:-agentxchange}"
LOCATION="${AGENTXCHANGE_LOCATION:-westus3}"
NAME="${AGENTXCHANGE_NAME:-agentxchange}"
DATABASE="${AGENTXCHANGE_DATABASE:-pglite}"
TEMPLATE="infra/main.bicep"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

command -v az >/dev/null || die "The Azure CLI (az) is not installed. See https://learn.microsoft.com/cli/azure/install-azure-cli"
az account show >/dev/null 2>&1 || die "You are not signed in to Azure. Run: az login"
SUBSCRIPTION="$(az account show --query name -o tsv)"
[[ "$DATABASE" == "pglite" || "$DATABASE" == "postgres" ]] || die "AGENTXCHANGE_DATABASE must be pglite or postgres."

PARAMS=(name="$NAME" database="$DATABASE")
if [ "$DATABASE" = "postgres" ]; then
  PASSWORD="${AGENTXCHANGE_DB_PASSWORD:-}"
  if [ -z "$PASSWORD" ]; then
    printf 'Choose a database password (12+ letters and digits, with upper case, lower case and a digit).\n'
    printf 'Use the same one each time you re-deploy. Password: '
    read -rs PASSWORD
    printf '\n'
  fi
  [[ "$PASSWORD" =~ ^[A-Za-z0-9]{12,64}$ ]] || die "The password must be 12 to 64 letters and digits only."
  [[ "$PASSWORD" =~ [A-Z] && "$PASSWORD" =~ [a-z] && "$PASSWORD" =~ [0-9] ]] || die "The password needs an upper-case letter, a lower-case letter and a digit."
  PARAMS+=(dbPassword="$PASSWORD")
  COST='about $20 a month (database $13-15, registry $5, app near zero when idle)'
  NAMESPACES="Microsoft.App Microsoft.ContainerRegistry Microsoft.OperationalInsights Microsoft.DBforPostgreSQL"
else
  COST='about $5 a month (registry $5, file share a few cents, app near zero when idle)'
  NAMESPACES="Microsoft.App Microsoft.ContainerRegistry Microsoft.OperationalInsights Microsoft.Storage"
fi

cat <<SUMMARY

This will create or update agentXchange in Azure:
  Subscription:    $SUBSCRIPTION
  Resource group:  $GROUP
  Region:          $LOCATION
  Database:        $DATABASE
  Rough cost:      $COST
  Time:            10 to 15 minutes on a first deploy
SUMMARY
if [ "${AGENTXCHANGE_YES:-}" != "1" ]; then
  read -r -p "Continue? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || die "Cancelled. Nothing was changed."
fi

say "Making sure the Azure services this needs are switched on for your subscription"
for namespace in $NAMESPACES; do
  az provider register --namespace "$namespace" --wait -o none
done

say "Creating the resource group"
az group create --name "$GROUP" --location "$LOCATION" -o none

say "Checking the template before creating anything"
az deployment group validate --resource-group "$GROUP" --template-file "$TEMPLATE" \
  --parameters "${PARAMS[@]}" -o none

say "Pass 1 of 2: registry, data store and environment (a postgres database takes several minutes)"
az deployment group create --resource-group "$GROUP" --name agentxchange-base --template-file "$TEMPLATE" \
  --parameters "${PARAMS[@]}" -o none
REGISTRY="$(az deployment group show --resource-group "$GROUP" --name agentxchange-base --query properties.outputs.registryName.value -o tsv)"
SERVER="$(az deployment group show --resource-group "$GROUP" --name agentxchange-base --query properties.outputs.registryServer.value -o tsv)"
[ -n "$REGISTRY" ] || die "Could not read the registry name from the deployment."

TAG="$(date +%Y%m%d%H%M%S)"
say "Building the app image in Azure ($SERVER/agentxchange:$TAG)"
az acr build --registry "$REGISTRY" --image "agentxchange:$TAG" .

say "Pass 2 of 2: the app itself"
az deployment group create --resource-group "$GROUP" --name agentxchange-app --template-file "$TEMPLATE" \
  --parameters "${PARAMS[@]}" image="$SERVER/agentxchange:$TAG" -o none
URL="$(az deployment group show --resource-group "$GROUP" --name agentxchange-app --query properties.outputs.url.value -o tsv)"
[ -n "$URL" ] || die "The app deployed but its address could not be read. Look for it in the Azure portal under $GROUP."

say "Waiting for the app to answer at $URL"
for attempt in $(seq 1 36); do
  if curl -fsS --max-time 10 "$URL/healthz" >/dev/null 2>&1; then
    cat <<DONE

agentXchange is live:  $URL

Check it end to end:   npm run e2e -- --url=$URL
Remove everything:     az group delete --name $GROUP
DONE
    exit 0
  fi
  sleep 5
done
die "The app was deployed but did not answer within 3 minutes. See its logs with:
  az containerapp logs show --resource-group $GROUP --name $NAME --tail 50"
