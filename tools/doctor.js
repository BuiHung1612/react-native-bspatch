#!/usr/bin/env node
/**
 * doctor.js — checks the whole OTA setup of a project for one release + flavor, read-only.
 * Run by `npx react-native-bspatch doctor` after the registry was synced from R2 (so the
 * R2 credentials already work when this runs).
 *
 * Usage: node doctor.js <projectRoot> <registryPath> <appVersion> <flavor> <baseUrl> <baseFolder>
 * Exit 1 when a check fails.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [root, registryPath, appVersion, flavor, baseUrl, folder] = process.argv.slice(2);
const tty = process.stdout.isTTY;
const c = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
let failed = 0;
const line = (mark, label, text) => console.log(`  ${mark} ${c('36', label.padEnd(10))}${text}`);
const ok = (label, text) => line(c('32', '✓'), label, text);
const warn = (label, text) => line(c('33', '⚠'), label, text);
const bad = (label, text) => {
  failed++;
  line(c('31', '✗'), label, text);
};
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
};
const find = (dir, name) => {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 10) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (['Pods', 'build', 'node_modules', '.gradle'].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === name) out.push(full);
    }
  };
  walk(path.join(root, dir), 0);
  return out;
};

(async () => {
  console.log(`\n  ${c('1', 'doctor')} ${c('2', `· ${appVersion} · ${flavor}`)}\n`);
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const group = registry.apps?.[appVersion]?.flavors?.[flavor];

  // ── Storage: the URL the app reads serves what was uploaded to the bucket ──
  if (/\.r2\.dev\b/.test(baseUrl)) warn('storage', `${baseUrl} is R2's rate-limited dev URL: connect a custom domain for production`);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/${folder}/ota_registry.json?cb=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 && !Object.keys(registry.apps || {}).length) {
      warn('storage', `${new URL(baseUrl).host} works; nothing published to this bucket yet (the first patch creates the registry)`);
      throw null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const served = await res.json();
    if (JSON.stringify(served) === JSON.stringify(registry)) ok('storage', `${new URL(baseUrl).host} serves the bucket's registry`);
    else bad('storage', `${new URL(baseUrl).host} serves a different registry than the bucket: OTA_BASE_URL in .env.${flavor} points at another bucket (or a stale cache)`);
  } catch (e) {
    if (e) bad('storage', `OTA_BASE_URL (${baseUrl}) doesn't serve ${folder}/ota_registry.json: ${e.message}`);
  }

  // ── Signing ──
  const key = spawnSync('node', [path.join(__dirname, 'ensure_signing_key.js'), root, registryPath, '--check'], { encoding: 'utf8' });
  const keyText = (key.stdout.trim() || key.stderr.trim().replace(/^\s*❌\s*/, '')).split('\n')[0];
  if (key.status === 0) ok('signing', keyText);
  else if (key.status === 2) warn('signing', keyText);
  else bad('signing', keyText);
  if (fs.existsSync(path.join(root, 'ota_private_key.backup.pem'))) {
    warn('backup', 'ota_private_key.backup.pem is on this machine: keep it offline (password manager) and delete it here');
  }

  // ── Native wiring ──
  const appDelegate = find('ios', 'AppDelegate.swift')[0];
  if (!appDelegate) warn('iOS', 'no AppDelegate.swift found');
  else if (fs.readFileSync(appDelegate, 'utf8').includes('OtaBundleResolver.resolve')) ok('iOS', 'AppDelegate loads the OTA bundle');
  else bad('iOS', 'AppDelegate doesn\'t load the OTA bundle: run `npx react-native-bspatch setup`');
  const pbxproj = find('ios', 'project.pbxproj')[0];
  if (pbxproj && !fs.readFileSync(pbxproj, 'utf8').includes('[react-native-bspatch] runtime fingerprint')) {
    bad('iOS', 'no runtime fingerprint build step: run `npx react-native-bspatch setup`, then rebuild');
  }
  const mainApp = find('android', 'MainApplication.kt')[0];
  if (!mainApp) warn('Android', 'no MainApplication.kt found');
  else if (fs.readFileSync(mainApp, 'utf8').includes('OtaBundleResolver.resolve')) ok('Android', 'MainApplication loads the OTA bundle');
  else bad('Android', 'MainApplication doesn\'t load the OTA bundle: run `npx react-native-bspatch setup`');

  let installed;
  try {
    installed = JSON.parse(read('node_modules/react-native-bspatch/package.json')).version;
  } catch {}
  const podVersion = read('ios/Podfile.lock').match(/- react-native-bspatch \(([^)]+)\)/)?.[1];
  if (installed && podVersion && podVersion !== installed) {
    bad('pods', `Podfile.lock has react-native-bspatch ${podVersion}, node_modules ${installed}: run pod install`);
  }

  // ── Native fingerprint vs what's live ──
  for (const platform of ['ios', 'android']) {
    const fp = spawnSync('node', [path.join(__dirname, 'fingerprint.js'), root, platform], { encoding: 'utf8' }).stdout.trim();
    const live = (group?.patches || []).find(e => e.platform === platform);
    if (!live) ok(platform, `fingerprint ${fp} ${c('2', '(no OTA live yet)')}`);
    else if (!live.runtimeFingerprint) warn(platform, `fingerprint ${fp}; live v${live.toVersion} has none (published by an older CLI)`);
    else if (live.runtimeFingerprint === fp) ok(platform, `fingerprint ${fp} = live v${live.toVersion}`);
    else warn(platform, `fingerprint ${fp} ≠ live v${live.toVersion} (${live.runtimeFingerprint}): native code changed, the next OTA only reaches a new store build`);
  }

  // ── Tools ──
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) bad('node', `Node ${process.versions.node}: 18+ needed`);
  const hermesc = ['node_modules/hermes-compiler/hermesc', 'node_modules/react-native/sdks/hermesc']
    .flatMap(d => ['osx-bin', 'linux64-bin'].map(b => path.join(root, d, b, 'hermesc')))
    .find(p => fs.existsSync(p));
  if (hermesc) ok('hermesc', path.relative(root, hermesc));
  else bad('hermesc', 'not found in node_modules: is react-native installed?');

  console.log(failed ? `\n  ${c('31', `${failed} problem(s)`)}\n` : `\n  ${c('32', 'all good')}\n`);
  process.exit(failed ? 1 : 0);
})();
