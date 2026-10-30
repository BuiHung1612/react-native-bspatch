#!/usr/bin/env node
/**
 * ota_admin.js — release controls and status for one release + flavor (run by build_ota.sh
 * after it synced the registry).
 *
 *   status                      what's live per platform (+ its release_*.json details)
 *   disable N | enable N        kill switch: no client installs vN
 *   rollout N <percent>         staged rollout: that share of installs gets vN (100 = everyone)
 *   mandatory N [--off]         apply vN as soon as it's ready instead of on the next launch
 *   qa N --ids a,b | --off      only these install IDs (useOta().installId) get vN
 *
 * Controls live on the registry entries of the live version and aren't signed: they can
 * only hold an update back or release one that is already signed.
 *
 * Usage: node ota_admin.js <command> <registry> <appVersion> <flavor> <releasesDir>
 *        [--platform p] [--ids a,b] [--off] [--json] [N] [percent]
 * Exit 3 when the registry changed (build_ota.sh uploads it), 1 on error.
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const [command, registryPath, appVersion, flavor, releasesDir] = argv;
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const platform = flag('--platform');
const off = argv.includes('--off');
const json = argv.includes('--json');
const numbers = argv.slice(5).filter((a, i, all) => /^\d+$/.test(a) && !['--platform', '--ids'].includes(all[i - 1]));
const [version, percent] = numbers.map(Number);

const tty = process.stdout.isTTY;
const c = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const fail = (message) => {
  console.error(`  ❌ ${message}`);
  process.exit(1);
};

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const group = registry.apps?.[appVersion]?.flavors?.[flavor];
if (!group?.patches?.length) fail(`No OTA published for ${appVersion} / ${flavor} yet`);
const entries = group.patches.filter(e => !platform || e.platform === platform);

const controls = (e) =>
  [
    e.disabled && c('31', 'disabled'),
    e.rolloutPercent !== undefined && c('33', `rollout ${e.rolloutPercent}%`),
    e.allowInstallIds?.length && c('35', `QA ${e.allowInstallIds.length} install(s)`),
    e.mandatory && c('36', 'mandatory'),
  ].filter(Boolean);

if (command === 'status') {
  const platforms = [...new Set(entries.map(e => e.platform))].sort();
  const report = platforms.map(p => {
    const live = entries.filter(e => e.platform === p);
    const full = live.find(e => !e.filename) || live[0];
    const file = path.join(releasesDir, `release_${appVersion}_v${full.toVersion}_${p}_${flavor}.json`);
    const release = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    return { platform: p, version: full.toVersion, patchesFrom: live.filter(e => e.filename).map(e => e.fromVersion), entry: full, release };
  });
  if (json) {
    console.log(JSON.stringify({ appVersion, flavor, latestOtaVersion: group.latestOtaVersion, platforms: report }));
    process.exit(0);
  }
  console.log(`  ${c('1', `${appVersion} · ${flavor}`)}  ${c('2', `latest v${group.latestOtaVersion}`)}\n`);
  for (const { platform: p, version: v, patchesFrom, entry, release } of report) {
    const state = controls(entry);
    console.log(`  ${c('1', p.padEnd(8))} v${v}  ${state.length ? state.join(' · ') : c('32', 'live for everyone')}`);
    const row = (k, text) => console.log(`    ${c('36', k.padEnd(10))}${text}`);
    if (release) {
      row('published', `${release.publishedAt.replace('T', ' ').slice(0, 16)} UTC by ${release.publishedBy || '?'}`);
      if (release.notes) row('notes', release.notes);
      if (release.git) row('commit', `${release.git.commit.slice(0, 7)} ${c('2', release.git.branch)}${release.git.dirty ? c('33', ' + uncommitted changes') : ''}`);
      row('bundle', `${(release.bundle.gzipSize / 1048576).toFixed(1)} MB gzip · ${(release.bundle.size / 1048576).toFixed(1)} MB raw`);
    }
    row('patches', patchesFrom.length ? patchesFrom.map(f => `v${f}`).join(', ') : c('2', 'none (full bundle only)'));
    row('native', `${entry.runtimeFingerprint || '?'} ${c('2', `· hermes bytecode ${entry.hermesBytecodeVersion ?? '?'}`)}`);
    row('signed', entry.entrySignature ? c('32', '✓') : c('33', 'no'));
    if (entry.allowInstallIds?.length) row('QA ids', entry.allowInstallIds.join(', '));
    console.log('');
  }
  process.exit(0);
}

// ── Controls: on the live version only (older versions' entries are gone from the registry) ──
if (!Number.isInteger(version)) fail(`${command} needs a version, e.g. ${command} ${group.latestOtaVersion}`);
const targets = entries.filter(e => e.toVersion === version);
if (!targets.length) {
  fail(`v${version} isn't live for ${appVersion} / ${flavor}${platform ? ` / ${platform}` : ''} (latest is v${group.latestOtaVersion}): controls apply to the live version`);
}
const apply = (fn) => targets.forEach(fn);
let summary;
switch (command) {
  case 'disable':
    apply(e => (e.disabled = true));
    summary = c('31', `v${version} disabled`) + ': no client installs it; clients already on it stay';
    break;
  case 'enable':
    apply(e => delete e.disabled);
    summary = c('32', `v${version} enabled`);
    break;
  case 'rollout':
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) fail('rollout needs a percent 0-100, e.g. rollout 7 20');
    apply(e => (percent === 100 ? delete e.rolloutPercent : (e.rolloutPercent = percent)));
    summary = percent === 100 ? c('32', `v${version} rolled out to everyone`) : c('33', `v${version} → ${percent}% of installs`);
    break;
  case 'mandatory':
    apply(e => (off ? delete e.mandatory : (e.mandatory = true)));
    summary = off ? `v${version} no longer mandatory` : c('36', `v${version} mandatory`) + ': applies as soon as it is downloaded';
    break;
  case 'qa': {
    if (off) {
      apply(e => delete e.allowInstallIds);
      summary = `v${version} QA list removed`;
      break;
    }
    const ids = (flag('--ids') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) fail('qa needs --ids <installId,…> (useOta().installId) or --off');
    apply(e => (e.allowInstallIds = ids));
    summary = c('35', `v${version} → QA only`) + ` (${ids.length} install${ids.length > 1 ? 's' : ''})`;
    break;
  }
  default:
    fail(`Unknown command ${command}`);
}
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`  ${summary} ${c('2', `· ${[...new Set(targets.map(e => e.platform))].join(' + ')}`)}`);
process.exit(3);
