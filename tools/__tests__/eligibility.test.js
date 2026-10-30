// node tools/__tests__/eligibility.test.js
// Which registry entries a client may install (src/ota/eligibility.ts, transpiled as-is).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const { outputText } = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '../../src/ota/eligibility.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } },
);
const mod = { exports: {} };
new Function('module', 'exports', outputText)(mod, mod.exports);
const { ineligibleReason, rolloutBucket } = mod.exports;

const ctx = { platform: 'ios', failedVersions: [], runtimeFingerprint: 'aaaa', hermesBytecodeVersion: 98, installId: 'install-1' };
const entry = { platform: 'ios', toVersion: 7, runtimeFingerprint: 'aaaa', hermesBytecodeVersion: 98, requires: ['gzip'] };
const why = (patch, c = ctx) => ineligibleReason({ ...entry, ...patch }, { ...ctx, ...c });

assert.strictEqual(why({}), null);
assert.match(why({ platform: 'android' }), /platform/);
assert.match(why({}, { failedVersions: [7] }), /crashed/);
assert.match(why({ disabled: true }), /disabled/);
assert.match(why({ requires: ['gzip', 'zstd'] }), /zstd/);
assert.match(why({ runtimeFingerprint: 'bbbb' }), /different native code/);
assert.match(why({}, { runtimeFingerprint: '' }), /no runtime fingerprint/);
assert.strictEqual(why({ runtimeFingerprint: undefined }), null); // older entries without one
assert.match(why({ hermesBytecodeVersion: 96 }), /Hermes/);
assert.strictEqual(why({}, { hermesBytecodeVersion: undefined }), null); // not on Hermes: can't tell
assert.match(why({ allowInstallIds: ['someone-else'] }), /QA/);
assert.strictEqual(why({ allowInstallIds: ['install-1'] }), null);
assert.match(why({ rolloutPercent: 0 }), /rollout/);
assert.strictEqual(why({ rolloutPercent: 100 }), null);

// Rollout: a stable bucket per install, ~the right share, a different slice per version
const ids = Array.from({ length: 5000 }, (_, i) => `id-${i}`);
const share = ids.filter(id => rolloutBucket(id, 7) < 20).length / ids.length;
assert.ok(share > 0.17 && share < 0.23, `20% rollout reached ${(share * 100).toFixed(1)}%`);
assert.strictEqual(rolloutBucket('id-42', 7), rolloutBucket('id-42', 7));
const sameSlice = ids.filter(id => (rolloutBucket(id, 7) < 20) === (rolloutBucket(id, 8) < 20)).length / ids.length;
assert.ok(sameSlice < 0.8, 'each version gets its own slice of installs');

console.log('eligibility: ok');
