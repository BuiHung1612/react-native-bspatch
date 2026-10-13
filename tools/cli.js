#!/usr/bin/env node
// Yarn Berry runs package bins with node regardless of the shebang, so the bash CLI needs a JS entry
const { spawnSync } = require('child_process');
const path = require('path');

const result = spawnSync('bash', [path.join(__dirname, 'build_ota.sh'), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
