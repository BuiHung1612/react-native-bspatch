#!/usr/bin/env node
/**
 * ensure_signing_key.js — run by `patch` before building, so signing needs no setup step.
 *
 * The app embeds two public keys: the signing key and an offline backup
 * (ota_private_key.backup.pem), so a lost or leaked signing key is replaced by promoting
 * the backup, without a store build.
 *
 * Key present → every place the app has keys (Info.plist, Android resource, `publicKey:`
 * in JS) must include it; it gets embedded natively, with a backup, if the app has none.
 * Key missing → a new pair is created and embedded, but only for an app that has never
 * been signed: a new key for an app whose installs verify the old one would make every
 * update fail, so that case (and CI) stops with what to do instead.
 *
 * Usage: node ensure_signing_key.js <projectRoot> <registryPath> [--interactive | --check]
 * --check (doctor): never writes; exit 2 when `patch` would create or embed something.
 * stdout: one status line. Errors and guidance go to stderr; exit 1 on error.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [root, registryPath, ...flags] = process.argv.slice(2);
const interactive = flags.includes('--interactive');
const checkOnly = flags.includes('--check');
const KEY_FILE = path.join(root, 'ota_private_key.pem');
const BACKUP_FILE = path.join(root, 'ota_private_key.backup.pem');
const ANDROID_RES = path.join(root, 'android/app/src/main/res/values/bspatch_public_key.xml');

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const rel = (p) => path.relative(root, p);
const spki = (key) => crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
const keyId = (der) => crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
const split = (keys) => keys.split(/[\s,]+/).filter(Boolean);
const newPrivateKey = () =>
  crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
const ignore = (file) => {
  const gitignore = path.join(root, '.gitignore');
  const name = path.basename(file);
  const content = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  if (!new RegExp(`^/?${name.replace(/\./g, '\\.')}$`, 'm').test(content)) {
    fs.appendFileSync(gitignore, `${content.endsWith('\n') || !content ? '' : '\n'}${name}\n`);
  }
};
/** The backup's public key, creating the backup (gitignored) if there is none */
const backupPublicKey = () => {
  if (!fs.existsSync(BACKUP_FILE)) {
    fs.writeFileSync(BACKUP_FILE, newPrivateKey(), { mode: 0o600 });
    ignore(BACKUP_FILE);
    console.error(
      `  ✓ Created the backup signing key ${rel(BACKUP_FILE)}: move it OFF this machine (password manager).\n` +
        '    If the signing key is ever lost or leaked, put it back as ota_private_key.pem: installed apps already trust it.',
    );
  }
  return spki(fs.readFileSync(BACKUP_FILE, 'utf8')).toString('base64');
};

/** The app target's Info.plist files (one per target/configuration), test targets excluded */
const infoPlists = () => {
  const iosDir = path.join(root, 'ios');
  let projects = [];
  try {
    projects = fs.readdirSync(iosDir).filter(f => f.endsWith('.xcodeproj'));
  } catch {
    return [];
  }
  const plists = new Set();
  for (const project of projects) {
    const pbx = fs.readFileSync(path.join(iosDir, project, 'project.pbxproj'), 'utf8');
    for (const [, value] of pbx.matchAll(/INFOPLIST_FILE = "?([^";]+)"?;/g)) {
      if (/Tests/.test(value)) continue;
      const file = path.join(iosDir, value.replace(/^\$\(SRCROOT\)\/?/, ''));
      if (fs.existsSync(file)) plists.add(file);
    }
  }
  return [...plists];
};

/** Public keys the app already ships: [{ where, keys, native }] */
const appKeys = () => {
  const keys = [];
  for (const plist of infoPlists()) {
    try {
      const key = execFileSync('plutil', ['-extract', 'BsPatchPublicKey', 'raw', '-o', '-', plist], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      if (key) keys.push({ where: rel(plist), keys: split(key), native: true });
    } catch {} // no such key (or no plutil off macOS)
  }
  const res = fs.existsSync(ANDROID_RES) && fs.readFileSync(ANDROID_RES, 'utf8').match(/<string[^>]*>([^<]+)</);
  if (res) keys.push({ where: rel(ANDROID_RES), keys: split(res[1]), native: true });
  // `publicKey: '…'` passed to OtaProvider
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'ios', 'android', '.git'].includes(e.name) && !e.name.startsWith('.')) walk(full);
      } else if (/\.(tsx?|jsx?)$/.test(e.name)) {
        const m = fs.readFileSync(full, 'utf8').match(/publicKey\s*:\s*['"`]([A-Za-z0-9+/=\s-]{100,}?)['"`]/);
        if (m) keys.push({ where: rel(full), keys: split(m[1]), native: false });
      }
    }
  };
  walk(root);
  return keys;
};

/** Where the app embeds keys natively (Info.plist needs plutil: macOS only) */
const nativeSpots = () => [
  ...(fs.existsSync(path.dirname(path.dirname(ANDROID_RES))) ? [rel(ANDROID_RES)] : []),
  ...(process.platform === 'darwin' ? infoPlists().map(rel) : []),
];

/** Embeds the public keys natively (comma-separated), in `only` (default: everywhere); returns where they went */
const embed = (publicKeys, only = nativeSpots()) => {
  const publicKeyBase64 = publicKeys.join(',');
  const written = [];
  if (only.includes(rel(ANDROID_RES))) {
    fs.mkdirSync(path.dirname(ANDROID_RES), { recursive: true });
    fs.writeFileSync(
      ANDROID_RES,
      `<?xml version="1.0" encoding="utf-8"?>
<!-- react-native-bspatch: public key OTA updates are verified with (not a secret) -->
<resources>
    <string name="bspatch_public_key" translatable="false">${publicKeyBase64}</string>
</resources>
`,
    );
    written.push(rel(ANDROID_RES));
  }
  for (const plist of infoPlists().filter(p => only.includes(rel(p)))) {
    execFileSync('plutil', ['-replace', 'BsPatchPublicKey', '-string', publicKeyBase64, plist]);
    written.push(rel(plist));
  }
  return written;
};

const registrySigned = () => {
  try {
    const { apps = {} } = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return Object.values(apps).some(app =>
      Object.values(app.flavors || {}).some(f =>
        (f.patches || []).some(e => e.entrySignature || e.bundleSignature || e.signature),
      ),
    );
  } catch {
    return false;
  }
};

const known = appKeys();
const privateKey = process.env.OTA_PRIVATE_KEY || (fs.existsSync(KEY_FILE) && fs.readFileSync(KEY_FILE, 'utf8'));

if (privateKey) {
  let der;
  try {
    der = spki(privateKey);
  } catch (e) {
    fail(`  ❌ The OTA signing key can't be read (${process.env.OTA_PRIVATE_KEY ? 'OTA_PRIVATE_KEY' : rel(KEY_FILE)}): ${e.message}`);
  }
  const publicKeyBase64 = der.toString('base64');
  const wrong = known.filter(k => !k.keys.includes(publicKeyBase64));
  if (wrong.length) {
    fail(
      `  ❌ The OTA signing key isn't one of the public keys in ${wrong.map(k => k.where).join(', ')}.\n` +
        '     Installed apps would reject every update signed with it: use the original ota_private_key.pem\n' +
        '     (or the backup key, if the app embeds it).',
    );
  }
  // Every native location needs it: one platform with a key doesn't cover the other's store builds
  const missing = nativeSpots().filter(w => !known.some(k => k.native && k.where === w));
  if (checkOnly && missing.length) {
    console.log(`key ${keyId(der)} · not embedded in ${missing.join(', ')} yet (the next patch embeds it)`);
    process.exit(2);
  }
  if (!missing.length) {
    console.log(`key ${keyId(der)}`);
  } else {
    // The same keys as the other platform (signing + its backup), or a new backup
    const embedded = known.find(k => k.native)?.keys;
    const where = embed(embedded || [publicKeyBase64, backupPublicKey()], missing);
    console.error(`  ✓ Embedded the signing + backup public keys in ${where.join(', ')}: commit them; store builds from now on verify updates.`);
    console.log(`key ${keyId(der)} · embedded in app`);
  }
} else {
  if (known.length || registrySigned()) {
    fail(
      `  ❌ ota_private_key.pem not found, but this app already ${
        known.length ? `verifies updates with the keys in ${known.map(k => k.where).join(', ')}` : 'has signed releases'
      }.\n` +
        `     Copy the original key to ${KEY_FILE} (CI: set OTA_PRIVATE_KEY), or put the backup key there.\n` +
        "     Don't create a new one: installed apps would reject every update signed with it.",
    );
  }
  if (checkOnly) {
    console.log('no signing key yet (the next patch in a terminal creates one)');
    process.exit(2);
  }
  if (!interactive) {
    fail(
      '  ❌ No OTA signing key. Run `npx react-native-bspatch patch` once in a terminal: it creates one.\n' +
        '     Then add the key to CI as OTA_PRIVATE_KEY.',
    );
  }
  const pem = newPrivateKey();
  fs.writeFileSync(KEY_FILE, pem, { mode: 0o600 });
  ignore(KEY_FILE);
  const der = spki(pem);
  const where = embed([der.toString('base64'), backupPublicKey()]);
  console.error(
    `  ✓ Created the OTA signing key ${rel(KEY_FILE)} (gitignored) and embedded its public key, with the backup's, in:\n` +
      where.map(w => `      ${w}\n`).join('') +
      '    • Back the signing key up too (password manager, CI secret OTA_PRIVATE_KEY).\n' +
      '    • Commit the files above: store builds from now on verify every update.',
  );
  console.log(`key ${keyId(der)} · created`);
}
