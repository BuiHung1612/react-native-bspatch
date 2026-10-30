#!/usr/bin/env node
/**
 * verify_publish.js — after upload, read the release back the way the app will: through
 * OTA_BASE_URL. Catches an app pointed at another bucket, a CDN serving a stale registry,
 * a missing file, or an entry that doesn't verify against the signing key.
 *
 * Usage: node verify_publish.js <projectRoot> <baseUrl> <baseFolder> <appVersion> <flavor> <platform> <version>
 * stdout: one status line. stderr: the first line is the error; exit 1.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [root, baseUrl, folder, appVersion, flavor, platform, versionStr] = process.argv.slice(2);
const version = Number(versionStr);
const base = `${baseUrl.replace(/\/$/, '')}/${folder}`;

const fail = (message, detail = '') => {
  console.error(message + (detail ? `\n${detail}` : ''));
  process.exit(1);
};

/** Must stay equal to update_registry.js / src/ota/entrySignature.ts */
const entryPayload = e =>
  [
    'bspatch-entry-v2', e.appVersion, e.flavor ?? '', e.platform ?? '', e.fromVersion, e.toVersion,
    e.bundleHash ?? '', e.assetManifestHash ?? '', e.minAppVersion ?? '', e.runtimeFingerprint ?? '',
    e.hermesBytecodeVersion ?? '',
  ].join('\n');

const get = async (url, method = 'GET') => {
  const res = await fetch(url, { method, headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
};

(async () => {
  let registry;
  try {
    registry = await (await get(`${base}/ota_registry.json?cb=${Date.now()}`)).json();
  } catch (e) {
    fail(`OTA_BASE_URL doesn't serve the registry: ${e.message}`);
  }
  const group = registry?.apps?.[appVersion]?.flavors?.[flavor];
  const entries = (group?.patches || []).filter(e => e.platform === platform && e.toVersion === version);
  if (!entries.length) {
    fail(
      `${new URL(baseUrl).host} doesn't serve ${platform} v${version}: the app reads another bucket or a stale cache`,
      `  It serves latest v${group?.latestOtaVersion ?? '?'} for ${appVersion}/${flavor}. Check OTA_BASE_URL in .env.${flavor} ` +
        'against the bucket this upload went to (R2 → bucket → Settings → Custom Domains / Public URL).',
    );
  }

  const keyPem = process.env.OTA_PRIVATE_KEY ||
    (fs.existsSync(path.join(root, 'ota_private_key.pem')) && fs.readFileSync(path.join(root, 'ota_private_key.pem'), 'utf8'));
  if (keyPem) {
    const publicKey = crypto.createPublicKey(keyPem);
    for (const e of entries) {
      const ok = e.entrySignature &&
        crypto.createVerify('SHA256').update(entryPayload(e)).verify(publicKey, e.entrySignature, 'base64');
      if (!ok) fail(`The served entry ${e.id} doesn't verify against the signing key`);
    }
  }

  // Every file a client of this version may fetch
  const files = new Set();
  for (const e of entries) {
    files.add(e.fullBundleUrl);
    if (e.filename) files.add(e.filename);
    if (e.assetManifestUrl) files.add(e.assetManifestUrl);
  }
  for (const file of files) {
    try {
      await get(`${base}/${appVersion}/${flavor}/${file}`, 'HEAD');
    } catch (e) {
      fail(`Uploaded but not served: ${file}`, `  ${e.message}`);
    }
  }
  console.log(`live at ${new URL(baseUrl).host}`);
})().catch(e => fail(`Verify failed: ${e.message}`));
