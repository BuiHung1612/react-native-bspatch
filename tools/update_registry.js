#!/bin/env node
/**
 * update_registry.js
 *
 * Called by build_ota.sh after generating patches.
 * 1. Reads  : android/output/ota_registry.json (or ios/output/...)
 * 2. Scopes to : appVersion (e.g. "1.0.0")
 * 3. Scopes to : flavor (e.g. "dev", "staging", "production")
 * 4. Writes the full-bundle entry + patch entries and latestOtaVersion for that app+flavor.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// ── Check for private key for asymmetric signing ───────────────────────────
let signingKey = process.env.OTA_PRIVATE_KEY || null;
if (!signingKey) {
  const candidateKeyPaths = [
    path.join(process.cwd(), 'ota_private_key.pem'),
    path.join(path.dirname(registryPath), 'ota_private_key.pem'),
    path.join(path.dirname(registryPath), '../ota_private_key.pem'),
  ];
  for (const kp of candidateKeyPaths) {
    if (fs.existsSync(kp)) {
      try {
        signingKey = fs.readFileSync(kp, 'utf8');
        break;
      } catch (e) {}
    }
  }
}

// ── Update entries ──────────────────────────────────────────────────────────
// One full-bundle entry (no `filename`) + one entry per patch from an earlier OTA version
{
  // We merge patches by platform to avoid overwriting between Android and iOS
  const otherPlatformPatches = flavorGroup.patches.filter(p => p.platform !== platform);
  
  // Patches and bundles live next to the asset manifest (android/output or ios/output)
  const outputDir = path.dirname(_assetManifestFile);
  const fullBundleName = `bundle_${appVersion}_v${toOtaVersion}_${platform}_${flavor}.hbc`;
  const manifestName = path.basename(_assetManifestFile);

  const sign = (file) => {
    if (!signingKey) return undefined;
    const filePath = path.join(outputDir, file);
    if (!fs.existsSync(filePath)) {
      console.error(`  ❌ Cannot sign ${file}: not found at ${filePath}`);
      process.exit(1);
    }
    const signer = crypto.createSign('SHA256');
    signer.update(fs.readFileSync(filePath));
    return signer.sign(signingKey, 'base64');
  };

  // Signature of the resulting bundle: verified by the client on BOTH the patch
  // path and the full-bundle fallback, so a tampered registry can't swap bundles.
  const bundleSignature = sign(fullBundleName);

  const bundleHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(outputDir, fullBundleName)))
    .digest('hex');

  const entry = (from, extra) => ({
    id: `v${from}-to-v${toOtaVersion}-${flavor}-${platform}`,
    label: `V${from} → V${toOtaVersion} (${flavor} ${platform})`,
    appVersion,
    fromVersion: from,
    toVersion: toOtaVersion,
    platform,
    bundleHash,
    fullBundleUrl: fullBundleName,
    assetManifestUrl: manifestName,
    flavor,
    bundleSignature,
    ...extra,
  });

  // fromVersion 1 = the store build, whose clients always take the full bundle
  const fullEntry = entry(1, {
    id: `full-to-v${toOtaVersion}-${flavor}-${platform}`,
    label: `Full V${toOtaVersion} (${flavor} ${platform})`,
  });
  const patchEntries = newPatches.map(p =>
    entry(p.from, { filename: p.file, baseHash: p.baseHash, signature: sign(p.file) }),
  );

  flavorGroup.patches = [...otherPlatformPatches, fullEntry, ...patchEntries];
}

// ── Write updated registry ───────────────────────────────────────────────────
fs.mkdirSync(path.dirname(registryPath), { recursive: true });
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
// Same layout as build_ota.sh step details
const patchCount = newPatches.length;
console.log(
  `        ${'entries'.padEnd(18)} full bundle${patchCount ? ` + ${patchCount} patch${patchCount > 1 ? 'es' : ''}` : ''}` +
    (signingKey ? ' · signed' : ' · unsigned (no ota_private_key.pem)'),
);
