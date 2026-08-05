#!/bin/env node
/**
 * update_registry.js
 *
 * Called by build_ota.sh after generating patches.
 * 1. Reads  : android/output/ota_registry.json (or ios/output/...)
 * 2. Scopes to : appVersion (e.g. "1.0.0")
 * 3. Scopes to : flavor (e.g. "dev", "staging", "production")
 * 4. Updates patches and latestOtaVersion for that specific app+flavor combination.
 * 5. Writes : otaPatches.generated.ts (flattened across all app versions/flavors)
 */

const fs = require('fs');
const path = require('path');

const [
  projectRoot,
  appVersion,
  toOtaVersionStr,
  patchesJson,
  platform = 'android',
  _assetManifestFile = '',
  flavorInput = 'dev',
] = process.argv.slice(2);

const toOtaVersion = parseInt(toOtaVersionStr, 10);
const newPatches = JSON.parse(patchesJson || '[]');

const flavor = flavorInput.toLowerCase();

const registryPath = projectRoot.endsWith('.json') 
  ? projectRoot 
  : path.join(projectRoot, 'ota_registry.json');

const generatedPath = projectRoot.endsWith('.json')
  ? path.join(path.dirname(projectRoot), 'src/ota/otaPatches.generated.ts')
  : path.join(projectRoot, 'src/ota/otaPatches.generated.ts');

// ── Load or init registry ───────────────────────────────────────────────────
let registry = { apps: {} };
if (fs.existsSync(registryPath)) {
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    console.warn('  ⚠ Failed to parse existing registry, starting fresh');
  }
}

// Ensure nested structure: apps -> appVersion -> flavors -> flavor
if (!registry.apps) registry.apps = {};
if (!registry.apps[appVersion]) {
  registry.apps[appVersion] = { flavors: {} };
}
if (!registry.apps[appVersion].flavors) {
  registry.apps[appVersion].flavors = {};
}
if (!registry.apps[appVersion].flavors[flavor]) {
  registry.apps[appVersion].flavors[flavor] = { latestOtaVersion: 0, patches: [] };
}

const flavorGroup = registry.apps[appVersion].flavors[flavor];
flavorGroup.latestOtaVersion = toOtaVersion;

// ── Update patches ──────────────────────────────────────────────────────────
if (newPatches.length > 0) {
  // We merge patches by platform to avoid overwriting between Android and iOS
  const otherPlatformPatches = flavorGroup.patches.filter(p => p.platform !== platform);
  
  const mappedNewPatches = newPatches.map(p => {
    // Naming convention from build_ota.sh
    const fullBundleName = `bundle_${appVersion}_v${toOtaVersion}_${platform}_${flavor}.hbc`;
    const manifestName = path.basename(_assetManifestFile);

    return {
      id: `v${p.from}-to-v${p.to}-${flavor}-${platform}`,
      label: `V${p.from} → V${p.to} (${flavor} ${platform})`,
      appVersion,
      filename: p.file,
      fromVersion: p.from,
      toVersion: p.to,
      platform,
      baseHash: p.baseHash || '',
      bundleHash: p.bundleHash || '',
      fullBundleUrl: fullBundleName,
      assetManifestUrl: manifestName,
      flavor: flavor,
    };
  });

  flavorGroup.patches = [...otherPlatformPatches, ...mappedNewPatches];
}

// ── Write updated registry ───────────────────────────────────────────────────
fs.mkdirSync(path.dirname(registryPath), { recursive: true });
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log(
  `  ✓ Registry updated | App: ${appVersion} | Flavor: ${flavor} | latestOta: ${toOtaVersion}`,
);
