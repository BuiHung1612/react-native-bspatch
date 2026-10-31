// node tools/__tests__/signing_key.test.js
// ensure_signing_key.js creates a key only for a never-signed app, and never lets a
// patch go out with a key the installed apps don't have.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '../ensure_signing_key.js');
const MAC = process.platform === 'darwin'; // Info.plist checks need plutil

const project = ({ registry = { apps: {} }, appTsx = '' } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bspatch-key-'));
  fs.mkdirSync(path.join(root, 'android/app/src/main/res/values'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ios/App.xcodeproj'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ios/App'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ios/App.xcodeproj/project.pbxproj'),
    'INFOPLIST_FILE = App/Info.plist;\nINFOPLIST_FILE = "AppTests/Info.plist";\n');
  fs.writeFileSync(path.join(root, 'ios/App/Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleName</key><string>App</string></dict></plist>\n');
  fs.writeFileSync(path.join(root, 'ota_registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  if (appTsx) fs.writeFileSync(path.join(root, 'App.tsx'), appTsx);
  return root;
};
const run = (root, { interactive = true, env = {} } = {}) => {
  const r = spawnSync('node', [SCRIPT, root, path.join(root, 'ota_registry.json'), ...(interactive ? ['--interactive'] : [])], {
    env: { ...process.env, OTA_PRIVATE_KEY: '', ...env },
  });
  return { code: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
};
const androidKey = root => fs.readFileSync(path.join(root, 'android/app/src/main/res/values/bspatch_public_key.xml'), 'utf8').match(/<string[^>]*>([^<]*)</)[1];
const spkiOf = pem => crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');

// 1. Never-signed app, in a terminal: signing + backup key created, ignored by git,
//    both public keys embedded on both platforms
let root = project();
let r = run(root);
assert.strictEqual(r.code, 0, r.err);
assert.match(r.out, /created/);
const pem = fs.readFileSync(path.join(root, 'ota_private_key.pem'), 'utf8');
const backupPem = fs.readFileSync(path.join(root, 'ota_private_key.backup.pem'), 'utf8');
for (const f of ['ota_private_key.pem', 'ota_private_key.backup.pem']) {
  assert.strictEqual((fs.statSync(path.join(root, f)).mode & 0o777), 0o600);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), new RegExp(`^${f.replace(/\./g, '\\.')}$`, 'm'));
}
assert.strictEqual(androidKey(root), `${spkiOf(pem)},${spkiOf(backupPem)}`);
if (MAC) assert.match(fs.readFileSync(path.join(root, 'ios/App/Info.plist'), 'utf8'), new RegExp(spkiOf(backupPem).slice(-40).replace(/[+/]/g, '\\$&')));

// 2. Second run: the same key is reused, nothing rewritten
r = run(root);
assert.strictEqual(r.code, 0, r.err);
assert.doesNotMatch(r.out, /created|embedded/);
assert.strictEqual(fs.readFileSync(path.join(root, 'ota_private_key.pem'), 'utf8'), pem);

// 3. Key file lost (new machine): refuses to create a new one, the app already ships the old one
fs.unlinkSync(path.join(root, 'ota_private_key.pem'));
r = run(root);
assert.strictEqual(r.code, 1);
assert.match(r.err, /Copy the original key/);
assert.ok(!fs.existsSync(path.join(root, 'ota_private_key.pem')));

// 4. A different key than the embedded ones: refused
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
r = run(root, { env: { OTA_PRIVATE_KEY: other } });
assert.strictEqual(r.code, 1);
assert.match(r.err, /isn't one of the public keys/);

// 4b. Signing key lost: the backup promoted to ota_private_key.pem signs without a store build
fs.copyFileSync(path.join(root, 'ota_private_key.backup.pem'), path.join(root, 'ota_private_key.pem'));
r = run(root);
assert.strictEqual(r.code, 0, r.err);

// 5. Registry already signed but nothing embedded (key verified from JS elsewhere): refused
root = project({ registry: { apps: { '1.0.0': { flavors: { dev: { patches: [{ bundleSignature: 'x' }] } } } } } });
r = run(root);
assert.strictEqual(r.code, 1);
assert.match(r.err, /has signed releases/);

// 6. CI (no terminal) without a key: refused, says how to fix
root = project();
r = run(root, { interactive: false });
assert.strictEqual(r.code, 1);
assert.match(r.err, /OTA_PRIVATE_KEY/);

// 7. publicKey passed in JS: a matching key also gets embedded natively (with a backup),
//    another key is refused
const pub = spkiOf(pem);
root = project({ appTsx: `const otaConfig = {\n  publicKey:\n    '${pub}',\n};\n` });
r = run(root, { env: { OTA_PRIVATE_KEY: pem } });
assert.strictEqual(r.code, 0, r.err);
assert.ok(androidKey(root).startsWith(`${pub},`));
r = run(root, { env: { OTA_PRIVATE_KEY: other } });
assert.strictEqual(r.code, 1);
assert.match(r.err, /App\.tsx/);

// 8. One platform has the keys, the other lost them: --check reports it, patch re-embeds the same keys
root = project();
run(root);
const keys = androidKey(root);
fs.unlinkSync(path.join(root, 'android/app/src/main/res/values/bspatch_public_key.xml'));
r = spawnSync('node', [SCRIPT, root, path.join(root, 'ota_registry.json'), '--check'], { env: { ...process.env, OTA_PRIVATE_KEY: '' } });
assert.strictEqual(r.status, 2, r.stderr.toString());
r = run(root);
assert.strictEqual(r.code, 0, r.err);
if (MAC) assert.strictEqual(androidKey(root), keys);

console.log(`signing key: ok${MAC ? '' : ' (Info.plist checks skipped: no plutil)'}`);
