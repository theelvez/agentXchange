// Builds the server (dependencies stay in node_modules) and the bridge
// (one self-contained file, so a guest can download and run it with nothing but Node).
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const common = { bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'info' };

await build({ ...common, entryPoints: ['src/server/index.ts'], outfile: 'dist/server.js', packages: 'external' });
await build({
  ...common,
  entryPoints: ['src/bridge/index.ts'],
  outfile: 'dist/bridge.js',
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
});
chmodSync('dist/bridge.js', 0o755);
