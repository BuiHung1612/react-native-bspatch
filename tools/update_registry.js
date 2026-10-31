#!/bin/env node
/**
 * update_registry.js
 *
 * Called by build_ota.sh after generating patches.
 * 1. Reads  : android/output/ota_registry.json (or ios/output/...)
 * 2. Scopes to : appVersion (e.g. "1.0.0")
 * 3. Scopes to : flavor (e.g. "dev", "staging", "production")
 * 4. Writes the full-bundle entry + patch entries and latestOtaVersion for that app+flavor.
 * 5. Writes next to the bundle: its gzip copy (uploaded Content-Encoded) and
 *    release_<app>_v<N>_<platform>_<flavor>.json, the version's details for a dashboard.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

/** What entrySignature signs. Must stay byte-for-byte equal to src/ota/entrySignature.ts */
const entryPayload = e =>
  [
    'bspatch-entry-v2',
    e.appVersion,
    e.flavor ?? '',
    e.platform ?? '',
    e.fromVersion,
    e.toVersion,
    e.bundleHash ?? '',
    e.assetManifestHash ?? '',
    e.minAppVersion ?? '',
    e.runtimeFingerprint ?? '',
    e.hermesBytecodeVersion ?? '',
  ].join('\n');

/** Adds KEY=value lines to build_ota.sh's report file (sourced for the summary) */
const report = (key, value) => {
  if (process.env.BSPATCH_REPORT) {
    fs.appendFileSync(process.env.BSPATCH_REPORT, `${key}='${String(value).replace(/'/g, `'\\''`)}'\n`);
  }
};

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
    // Starting fresh would publish a registry with only this flavor over the remote one
    console.error(`  ❌ ${registryPath} is not valid JSON (${e.message}): re-run to sync it from storage`);
    process.exit(1);
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

  const signBytes = (bytes) =>
    signingKey ? crypto.createSign('SHA256').update(bytes).sign(signingKey, 'base64') : undefined;
  const sign = (file) => {
    if (!signingKey) return undefined;
    const filePath = path.join(outputDir, file);
    if (!fs.existsSync(filePath)) {
      console.error(`  ❌ Cannot sign ${file}: not found at ${filePath}`);
      process.exit(1);
    }
    return signBytes(fs.readFileSync(filePath));
  };
  const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

  // Signature of the resulting bundle: verified by the client on BOTH the patch
  // path and the full-bundle fallback, so a tampered registry can't swap bundles.
  const bundleSignature = sign(fullBundleName);

  const bundleBytes = fs.readFileSync(path.join(outputDir, fullBundleName));
  const bundleHash = sha256(bundleBytes);
  const manifestBytes = fs.readFileSync(_assetManifestFile);
  const assetManifestHash = sha256(manifestBytes);
  // Hermes bytecode header: magic (8 bytes) then the bytecode version (uint32 LE)
  const hermesBytecodeVersion = bundleBytes.length >= 12 ? bundleBytes.readUInt32LE(8) : undefined;
  // Same inputs the Xcode/Gradle build hook stamps into the store binary; promote/rollback
  // pass the source version's own fingerprint (that bundle was built from another commit)
  const runtimeFingerprint =
    process.env.BSPATCH_FINGERPRINT ||
    execFileSync('node', [path.join(__dirname, 'fingerprint.js'), process.cwd(), platform]).toString().trim();
  const previous = flavorGroup.patches.find(p => p.platform === platform);
  if (previous?.runtimeFingerprint && previous.runtimeFingerprint !== runtimeFingerprint) {
    // Not an error: a new store build of this release takes it. Installed binaries won't.
    report('NATIVE_CHANGED', `v${previous.toVersion}`);
  }

  // Signed last: entryPayload reads the final fields
  const entry = (from, extra) => signEntry({
    id: `v${from}-to-v${toOtaVersion}-${flavor}-${platform}`,
    label: `V${from} → V${toOtaVersion} (${flavor} ${platform})`,
    appVersion,
    fromVersion: from,
    toVersion: toOtaVersion,
    platform,
    bundleHash,
    // Uploaded as a plain .gz (no Content-Encoding): resumable, with an exact progress total
    fullBundleUrl: `${fullBundleName}.gz`,
    fullBundleCompression: 'gzip',
    requires: ['gzip'],
    bundleSize: bundleBytes.length,
    runtimeFingerprint,
    hermesBytecodeVersion,
    assetManifestUrl: manifestName,
    assetManifestHash,
    flavor,
    bundleSignature,
    ...extra,
  });

  const signEntry = (e) => ({ ...e, entrySignature: signBytes(entryPayload(e)) });

  // fromVersion 1 = the store build, whose clients always take the full bundle
  const fullEntry = entry(1, {
    id: `full-to-v${toOtaVersion}-${flavor}-${platform}`,
    label: `Full V${toOtaVersion} (${flavor} ${platform})`,
  });
  const patchEntries = newPatches.map(p =>
    entry(p.from, { filename: p.file, baseHash: p.baseHash, signature: sign(p.file) }),
  );

  flavorGroup.patches = [...otherPlatformPatches, fullEntry, ...patchEntries];

  const gzipBytes = zlib.gzipSync(bundleBytes, { level: 9 });
  fs.writeFileSync(path.join(outputDir, `${fullBundleName}.gz`), gzipBytes);

  // ── Release details (public, next to the bundle; clients never read it) ──
  const git = (...args) => {
    try {
      return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return null;
    }
  };
  const commit = git('rev-parse', 'HEAD');
  const release = {
    schema: 1,
    appVersion,
    flavor,
    platform,
    version: toOtaVersion,
    publishedAt: new Date().toISOString(),
    publishedBy: git('config', 'user.name') || process.env.USER || null,
    notes: process.env.BSPATCH_NOTES || null,
    git: commit && {
      commit,
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      // Tracked files only: build output is often untracked
      dirty: !!git('status', '--porcelain', '--untracked-files=no'),
    },
    cliVersion: require('../package.json').version,
    bundle: { file: fullBundleName, hash: bundleHash, size: bundleBytes.length, gzipSize: gzipBytes.length },
    runtimeFingerprint,
    hermesBytecodeVersion,
    patches: newPatches.map(p => ({
      from: p.from,
      file: p.file,
      size: fs.statSync(path.join(outputDir, p.file)).size,
    })),
    assets: {
      manifest: manifestName,
      hash: assetManifestHash,
      count: (JSON.parse(manifestBytes).assets || []).length,
    },
    signing: signingKey && {
      keyId: sha256(crypto.createPublicKey(signingKey).export({ type: 'spki', format: 'der' })).slice(0, 16),
    },
  };
  fs.writeFileSync(
    path.join(outputDir, `release_${appVersion}_v${toOtaVersion}_${platform}_${flavor}.json`),
    JSON.stringify(release, null, 2) + '\n',
  );
}

// ── Write updated registry ───────────────────────────────────────────────────
fs.mkdirSync(path.dirname(registryPath), { recursive: true });
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
// "<entries> · <signing>": build_ota.sh shows it as the Registry step's result
const patchCount = newPatches.length;
console.log(
  `full bundle${patchCount ? ` + ${patchCount} patch${patchCount > 1 ? 'es' : ''}` : ''}` +
    (signingKey ? ' · signed' : ' · unsigned (no ota_private_key.pem)'),
);
