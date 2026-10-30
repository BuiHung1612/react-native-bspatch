#!/usr/bin/env node
/**
 * fingerprint.js — native runtime fingerprint: what an OTA's JS needs from the binary.
 *
 * Stamped into the store build (Xcode build phase → bspatch_fingerprint.txt in the .app,
 * Gradle → resValue bspatch_runtime_fingerprint) and recorded in every registry entry by
 * `patch`. A client only installs an OTA whose fingerprint matches its binary, so JS that
 * calls a native module the binary doesn't have never reaches it.
 *
 * Inputs (per platform): the react-native version, every direct dependency with native code
 * for that platform (name@version), and the native dependency lock: ios/Podfile.lock on iOS,
 * the dependency lines of the Gradle build files on Android. The app's own native sources
 * are not included: changing AppDelegate/MainApplication needs a new store build anyway.
 *
 * Usage: node fingerprint.js <projectRoot> <ios|android> [--explain]
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [root, platform, flag] = process.argv.slice(2);
if (!root || !['ios', 'android'].includes(platform)) {
  console.error('Usage: node fingerprint.js <projectRoot> <ios|android> [--explain]');
  process.exit(1);
}

const read = (file) => {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return '';
  }
};
const pkg = JSON.parse(read('package.json') || '{}');

const hasNative = (dir) => {
  const has = (p) => fs.existsSync(path.join(dir, p));
  if (platform === 'android') return has('android/build.gradle') || has('android/build.gradle.kts');
  try {
    return fs.readdirSync(dir).some(f => f.endsWith('.podspec')) || has('ios');
  } catch {
    return false;
  }
};

/** Hash of a package's native sources (ios/, android/src, cpp/, *.podspec, android/build.gradle) */
const nativeHash = (dir) => {
  const hash = crypto.createHash('sha256');
  const walk = (rel) => {
    const full = path.join(dir, rel);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) {
        if (!['build', '.cxx', '.gradle'].includes(name)) walk(path.join(rel, name));
      }
    } else {
      hash.update(rel).update(fs.readFileSync(full));
    }
  };
  for (const rel of ['ios', 'android/src', 'android/build.gradle', 'cpp']) walk(rel);
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.podspec')).sort()) walk(f);
  return hash.digest('hex').slice(0, 16);
};

const inputs = [];
for (const name of Object.keys(pkg.dependencies || {}).sort()) {
  const dir = path.join(root, 'node_modules', name);
  let version;
  try {
    version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch {
    continue; // not installed: can't be linked either
  }
  if (name === 'react-native-bspatch') {
    // Its own native code, not its version: a JS-only release of this library ships by OTA
    inputs.push(`dep ${name}#${nativeHash(dir)}`);
  } else if (name === 'react-native' || hasNative(dir)) {
    inputs.push(`dep ${name}@${version}`);
  }
}

if (platform === 'ios') {
  // Skipped: COCOAPODS: (the CocoaPods version that wrote the file) and this library's own
  // lines (its version and podspec checksum change with JS-only releases; nativeHash covers it)
  for (const line of read('ios/Podfile.lock').split('\n')) {
    if (line.trim() && !line.startsWith('COCOAPODS:') && !line.includes('react-native-bspatch')) {
      inputs.push(`pod ${line.trimEnd()}`);
    }
  }
} else {
  for (const file of ['android/build.gradle', 'android/app/build.gradle', 'android/settings.gradle']) {
    for (const line of read(file).split('\n')) {
      if (/^\s*(implementation|api|classpath|compileOnly|runtimeOnly|include)\b/.test(line)) {
        inputs.push(`gradle ${file}: ${line.trim()}`);
      }
    }
  }
  for (const line of read('android/gradle.properties').split('\n')) {
    if (/^\s*(newArchEnabled|hermesEnabled)\s*=/.test(line)) inputs.push(`prop ${line.trim()}`);
  }
}

const fingerprint = crypto.createHash('sha256').update(inputs.join('\n')).digest('hex').slice(0, 16);
if (flag === '--explain') console.error(inputs.join('\n'));
console.log(fingerprint);
