#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// bump_version.js — Synchronize App Version Across Platforms
//
// Updates:
//   - package.json ("version")
//   - android/app/build.gradle (versionName & increments versionCode)
//   - ios/*.xcodeproj/project.pbxproj (MARKETING_VERSION & increments CURRENT_PROJECT_VERSION)
//   - src/ota/otaConfig.ts (APP_VERSION, if it exists)
//
// Usage:
//   node bump_version.js <new_version> [--root <path>]
//   e.g. node bump_version.js 1.0.2
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let newVersion = '';
let rootDir = process.cwd();

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) {
    rootDir = path.resolve(args[i + 1]);
    i++;
  } else if (!args[i].startsWith('--')) {
    newVersion = args[i].trim();
  }
}

if (!newVersion) {
  console.error('Usage: node bump_version.js <new_version> [--root <path>]');
  console.error('Example: node bump_version.js 1.0.2');
  process.exit(1);
}

// Validate semver format loosely (e.g. 1.0.2 or 1.0.2-beta)
if (!/^\d+\.\d+\.\d+.*$/.test(newVersion)) {
  console.error(`Invalid version format: "${newVersion}". Expected semver (e.g. 1.0.2)`);
  process.exit(1);
}

console.log(`\n=== Bumping App Version to ${newVersion} ===\n`);
let changedCount = 0;

// 1. package.json
const pkgPath = path.join(rootDir, 'package.json');
if (fs.existsSync(pkgPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const oldVer = pkg.version;
    pkg.version = newVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`  ✓ package.json: ${oldVer} → ${newVersion}`);
    changedCount++;
  } catch (e) {
    console.warn(`  ⚠ Failed to update package.json: ${e.message}`);
  }
}

// 2. android/app/build.gradle
const gradlePath = path.join(rootDir, 'android/app/build.gradle');
if (fs.existsSync(gradlePath)) {
  try {
    let content = fs.readFileSync(gradlePath, 'utf8');
    let oldName = '';
    let newCode = 1;

    // Bump versionName
    content = content.replace(/versionName\s+["']([^"']+)["']/, (_, old) => {
      oldName = old;
      return `versionName "${newVersion}"`;
    });

    // Increment versionCode
    content = content.replace(/versionCode\s+(\d+)/, (_, code) => {
      newCode = parseInt(code, 10) + 1;
      return `versionCode ${newCode}`;
    });

    fs.writeFileSync(gradlePath, content, 'utf8');
    console.log(`  ✓ android/app/build.gradle: versionName "${oldName}" → "${newVersion}", versionCode → ${newCode}`);
    changedCount++;
  } catch (e) {
    console.warn(`  ⚠ Failed to update build.gradle: ${e.message}`);
  }
}

// 3. iOS Xcode project.pbxproj
const iosDir = path.join(rootDir, 'ios');
if (fs.existsSync(iosDir)) {
  try {
    const files = fs.readdirSync(iosDir);
    for (const f of files) {
      if (f.endsWith('.xcodeproj')) {
        const pbxPath = path.join(iosDir, f, 'project.pbxproj');
        if (fs.existsSync(pbxPath)) {
          let content = fs.readFileSync(pbxPath, 'utf8');

          // Replace MARKETING_VERSION
          content = content.replace(/MARKETING_VERSION\s*=\s*[^;]+;/g, `MARKETING_VERSION = ${newVersion};`);

          // Increment CURRENT_PROJECT_VERSION if numeric
          content = content.replace(/CURRENT_PROJECT_VERSION\s*=\s*(\d+);/g, (_, v) => {
            const nextV = parseInt(v, 10) + 1;
            return `CURRENT_PROJECT_VERSION = ${nextV};`;
          });

          fs.writeFileSync(pbxPath, content, 'utf8');
          console.log(`  ✓ ios/${f}/project.pbxproj: MARKETING_VERSION → ${newVersion}`);
          changedCount++;
        }
      }
    }
  } catch (e) {
    console.warn(`  ⚠ Failed to update iOS project: ${e.message}`);
  }
}

// 4. src/ota/otaConfig.ts (if exists)
const otaConfigPath = path.join(rootDir, 'src/ota/otaConfig.ts');
if (fs.existsSync(otaConfigPath)) {
  try {
    let content = fs.readFileSync(otaConfigPath, 'utf8');
    content = content.replace(/export const APP_VERSION = ['"][^'"]+['"];/, `export const APP_VERSION = '${newVersion}';`);
    fs.writeFileSync(otaConfigPath, content, 'utf8');
    console.log(`  ✓ src/ota/otaConfig.ts: APP_VERSION → '${newVersion}'`);
    changedCount++;
  } catch (e) {}
}

console.log(`\n✓ Done! Updated ${changedCount} file(s) to version ${newVersion}.\n`);
