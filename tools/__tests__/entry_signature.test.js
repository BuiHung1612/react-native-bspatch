// node tools/__tests__/entry_signature.test.js
// Runs update_registry.js on a fake build and checks what the client relies on:
// entrySignature verifies against the client's own entryPayload (src/ota/entrySignature.ts),
// fails once a signed field changes, and the gzip copy / release file are written.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const ts = require('typescript');

const ROOT = path.join(__dirname, '../..');
const { outputText } = ts.transpileModule(
  fs.readFileSync(path.join(ROOT, 'src/ota/entrySignature.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
);
const clientModule = { exports: {} };
new Function('module', 'exports', outputText)(clientModule, clientModule.exports);
const { entryPayload } = clientModule.exports;

for (const [type, options] of [['rsa', { modulusLength: 2048 }], ['ec', { namedCurve: 'P-256' }]]) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync(type, options);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bspatch-'));
  const out = path.join(dir, 'ios/output');
  fs.mkdirSync(out, { recursive: true });
  const bundle = crypto.randomBytes(4096);
  fs.writeFileSync(path.join(out, 'bundle_1.0.6_v3_ios_development.hbc'), bundle);
  fs.writeFileSync(path.join(out, 'patch_1.0.6_v2_to_v3_development_ios.patch'), 'patch');
  const manifest = path.join(out, 'asset-manifest_1.0.6_v3_ios_development.json');
  fs.writeFileSync(manifest, JSON.stringify({ assets: [{ hash: 'a'.repeat(64), ext: 'png', originalPath: 'x.png' }] }));
  const registry = path.join(dir, 'ota_registry.json');
  fs.writeFileSync(registry, '{"apps":{}}');

  execFileSync('node', [
    path.join(ROOT, 'tools/update_registry.js'), registry, '1.0.6', '3',
    JSON.stringify([{ from: 2, to: 3, file: 'patch_1.0.6_v2_to_v3_development_ios.patch', baseHash: 'b' }]),
    'ios', manifest, 'development',
  ], { cwd: dir, env: { ...process.env, OTA_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), BSPATCH_NOTES: 'fix login' } });

  const entries = JSON.parse(fs.readFileSync(registry, 'utf8')).apps['1.0.6'].flavors.development.patches;
  assert.strictEqual(entries.length, 2);
  const verify = e => crypto.createVerify('SHA256').update(entryPayload(e)).verify(publicKey, e.entrySignature, 'base64');
  for (const e of entries) {
    assert.ok(verify(e), `${type}: ${e.id} entrySignature`);
    assert.strictEqual(e.assetManifestHash, crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex'));
    assert.match(e.runtimeFingerprint, /^[0-9a-f]{16}$/);
    assert.strictEqual(e.hermesBytecodeVersion, bundle.readUInt32LE(8));
    assert.strictEqual(e.fullBundleUrl, 'bundle_1.0.6_v3_ios_development.hbc.gz');
    for (const [field, value] of [['flavor', 'production'], ['toVersion', 99], ['platform', 'android'], ['assetManifestHash', 'c'.repeat(64)], ['runtimeFingerprint', '0'.repeat(16)], ['hermesBytecodeVersion', 1]]) {
      assert.ok(!verify({ ...e, [field]: value }), `${type}: changing ${field} must break the signature`);
    }
  }

  assert.ok(zlib.gunzipSync(fs.readFileSync(path.join(out, 'bundle_1.0.6_v3_ios_development.hbc.gz'))).equals(bundle));
  const release = JSON.parse(fs.readFileSync(path.join(out, 'release_1.0.6_v3_ios_development.json'), 'utf8'));
  assert.strictEqual(release.version, 3);
  assert.strictEqual(release.notes, 'fix login');
  assert.strictEqual(release.bundle.size, 4096);
  assert.deepStrictEqual(release.patches.map(p => p.from), [2]);
  assert.strictEqual(release.assets.count, 1);
  assert.match(release.signing.keyId, /^[0-9a-f]{16}$/);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('entry signature: ok (rsa + ecdsa)');
