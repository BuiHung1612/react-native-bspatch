// node tools/__tests__/ota_metadata.test.js
// src/ota/otaMetadata.ts (transpiled as-is) against an in-memory native fs: installed versions
// carry the binary's runtimeFingerprint/appBuild, and cleanup drops rolled-back versions.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const files = new Map(); // path -> content; a dir is a key with content null
const native = {
  getDocumentDir: () => '/doc',
  getRuntimeFingerprint: () => 'fp-1',
  getAppBuild: () => { throw new Error('unavailable'); },
  exists: async p => files.has(p),
  readFile: async p => files.get(p),
  writeFile: async (p, c) => void files.set(p, c),
  mkdir: async p => void files.set(p, null),
  readDir: async dir => [...new Set([...files.keys()]
    .filter(p => p.startsWith(`${dir}/`))
    .map(p => p.slice(dir.length + 1).split('/')[0]))],
  removePath: async p => [...files.keys()].forEach(k => (k === p || k.startsWith(`${p}/`)) && files.delete(k)),
};

const { outputText } = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '../../src/ota/otaMetadata.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } },
);
const mod = { exports: {} };
const requireStub = name => name === 'react-native' ? { Platform: { select: o => o.ios } } : { default: native };
new Function('module', 'exports', 'require', '__DEV__', outputText)(mod, mod.exports, requireStub, false);
const { registerNewVersion, markHealthy, updateMetadata } = mod.exports;

(async () => {
  const base = { currentVersion: 4, previousVersions: [3], rollbackCount: 0, lastLaunchSuccessful: true };
  const installed = registerNewVersion(base, 5, '1.0.0');
  assert.strictEqual(installed.appVersion, '1.0.0');
  assert.strictEqual(installed.runtimeFingerprint, 'fp-1');
  assert.strictEqual(installed.appBuild, ''); // getter threw

  // v2 crashed and was rolled back; v6 is higher than current (install in progress)
  for (const v of [1, 2, 3, 4, 5, 6]) files.set(`/doc/ota/v${v}/main.jsbundle`, 'x');
  await updateMetadata(1, () => ({ ...installed, failedVersions: [2, 5] }));
  const healthy = await markHealthy(1, 5, '1.0.0');
  assert.strictEqual(healthy.runtimeFingerprint, 'fp-1'); // kept on later writes
  const left = (await native.readDir('/doc/ota')).filter(i => /^v\d+$/.test(i)).sort();
  // v1 base, v3/v4 rollback history, v5 current (never removed, even if listed failed), v6 in progress
  assert.deepStrictEqual(left, ['v1', 'v3', 'v4', 'v5', 'v6']);

  // Legacy metadata without appVersion gets the whole stamp once the running version renders
  await updateMetadata(1, () => base);
  const legacy = await markHealthy(1, 4, '1.0.0');
  assert.strictEqual(legacy.appVersion, '1.0.0');
  assert.strictEqual(legacy.runtimeFingerprint, 'fp-1');
  console.log('ota_metadata: ok');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
