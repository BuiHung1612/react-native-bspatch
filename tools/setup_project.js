#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// react-native-bspatch Setup Script
//
// Automatically injects OTA integration into a React Native project:
//   - iOS:     Patches AppDelegate.swift (import + bundleURL override)
//   - Android: Patches MainApplication.kt (import + jsBundleFilePath)
//
// Idempotent: safe to run multiple times; skips already-patched files.
// Usage: node setup_project.js [--root <path>]
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────────────

function findFile(baseDir, predicate, maxDepth = 10) {
    const results = [];
    function walk(dir, depth) {
        if (depth > maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full, depth + 1); }
            else if (predicate(e.name, full)) { results.push(full); }
        }
    }
    walk(baseDir, 0);
    return results;
}

function patchFile(filePath, label, patchFn) {
    if (!fs.existsSync(filePath)) {
        console.log(`  ⚠  ${label}: file not found at ${filePath}`);
        return false;
    }
    const original = fs.readFileSync(filePath, 'utf8');
    const patched = patchFn(original);
    if (patched === original) {
        console.log(`  ✓  ${label}: already set up (skipped)`);
        return false;
    }
    fs.writeFileSync(filePath, patched, 'utf8');
    console.log(`  ✓  ${label}: patched`);
    return true;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Older versions injected these to capture the store bundle (v1) as a patch source.
// OTA no longer patches from the store bundle, so setup removes them.
const LEGACY_XCODE_MARKER = '\\n# [react-native-bspatch] Sync compiled bundle to output/';
const LEGACY_GRADLE_MARKER = '// [react-native-bspatch] Auto-capture Base Bundle';

function removeAppBuildGradleSnippet(content) {
    const idx = content.indexOf(LEGACY_GRADLE_MARKER);
    if (idx === -1) return content;
    const end = findClosingParen(content, content.indexOf('{', content.indexOf('afterEvaluate', idx)), '{', '}');
    if (end === -1) return content;
    return content.slice(0, idx).trimEnd() + '\n' + content.slice(end + 1).trimStart();
}

const IOS_IMPORT = 'import react_native_bspatch';
const IOS_BUNDLE_URL_OVERRIDE = `
  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    if let otaBundle = OtaBundleResolver.resolve() {
        return otaBundle
    }
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
`;

const ANDROID_IMPORT = 'import vn.reactnativebspatch.OtaBundleResolver';
const ANDROID_JS_BUNDLE = 'jsBundleFilePath = OtaBundleResolver.resolve(applicationContext)';

function findClosingParen(source, openParenIdx, open = '(', close = ')') {
    let depth = 0;
    for (let i = openParenIdx; i < source.length; i += 1) {
        const char = source[i];
        if (char === open) {
            depth += 1;
        } else if (char === close) {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

// ── iOS: project.pbxproj ─────────────────────────────────────────────────────

function removePbxprojSnippet(content) {
    const idx = content.indexOf(LEGACY_XCODE_MARKER);
    if (idx === -1) return content;
    return content.slice(0, idx) + content.slice(content.indexOf('";', idx));
}

// ── iOS: AppDelegate.swift ────────────────────────────────────────────────────

function patchAppDelegate(content) {
    let result = content;
    let changed = false;

    // 1. Add import if missing
    if (!result.includes(IOS_IMPORT)) {
        // Insert after the last import line
        const lastImportMatch = [...result.matchAll(/^import .+$/gm)].pop();
        if (lastImportMatch) {
            const idx = lastImportMatch.index + lastImportMatch[0].length;
            result = result.slice(0, idx) + '\n' + IOS_IMPORT + result.slice(idx);
            changed = true;
        }
    }

    // 2. Add bundleURL override if missing
    if (!result.includes('OtaBundleResolver.resolve()')) {
        // Look for an existing bundleURL() function
        const bundleURLFnRegex = /override func bundleURL\(\)[^{]*\{[\s\S]*?\}/m;
        if (bundleURLFnRegex.test(result)) {
            // Replace existing bundleURL() entirely
            result = result.replace(bundleURLFnRegex, IOS_BUNDLE_URL_OVERRIDE.trim());
        } else {
            // Look for sourceURL override and insert bundleURL after it, or at end of class
            const sourceURLIdx = result.lastIndexOf('override func sourceURL');
            if (sourceURLIdx !== -1) {
                // Find end of that function
                const endBrace = result.indexOf('\n  }', sourceURLIdx) + 4;
                result = result.slice(0, endBrace) + '\n' + IOS_BUNDLE_URL_OVERRIDE + result.slice(endBrace);
            } else {
                // Insert before last closing brace of the file
                const lastBrace = result.lastIndexOf('}');
                result = result.slice(0, lastBrace) + IOS_BUNDLE_URL_OVERRIDE + '\n' + result.slice(lastBrace);
            }
        }
        changed = true;
    }

    return changed ? result : content;
}

// ── Android: MainApplication.kt ──────────────────────────────────────────────

function patchMainApplication(content) {
    let result = content;
    let changed = false;

    // 1. Add import if missing
    if (!result.includes(ANDROID_IMPORT)) {
        const lastImportMatch = [...result.matchAll(/^import .+$/gm)].pop();
        if (lastImportMatch) {
            const idx = lastImportMatch.index + lastImportMatch[0].length;
            result = result.slice(0, idx) + '\n' + ANDROID_IMPORT + result.slice(idx);
            changed = true;
        }
    }

    // 2. Add jsBundleFilePath if missing
    if (!result.includes('OtaBundleResolver.resolve')) {
        const hostCallMatch = result.match(/getDefaultReactHost\s*\(/);
        if (hostCallMatch && hostCallMatch.index !== undefined) {
            const hostCallStart = hostCallMatch.index;
            const openParenIdx = result.indexOf('(', hostCallStart);
            const closeIdx =
                openParenIdx === -1
                    ? -1
                    : findClosingParen(result, openParenIdx);

            if (closeIdx === -1) {
                console.log('    ⚠  Could not find the closing parenthesis for getDefaultReactHost(...). Please add jsBundleFilePath manually.');
            } else {
                const trailingWhitespaceMatch = result
                    .slice(0, closeIdx)
                    .match(/\s*$/);
                const trailingWhitespace =
                    trailingWhitespaceMatch?.[0] ?? '';
                const insertIdx = closeIdx - trailingWhitespace.length;
                const beforeClose = result.slice(0, insertIdx).trimEnd();
                const separator = beforeClose.endsWith(',') ? '\n' : ',\n';
                result =
                    result.slice(0, insertIdx) +
                    separator +
                    '      ' +
                    ANDROID_JS_BUNDLE +
                    trailingWhitespace +
                    result.slice(closeIdx);
                changed = true;
            }
        } else {
            console.log('    ⚠  Could not find getDefaultReactHost(...) call. Please add jsBundleFilePath manually.');
        }
    }

    return changed ? result : content;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
    // Determine project root
    const args = process.argv.slice(2);
    const rootIdx = args.indexOf('--root');
    const ROOT = rootIdx !== -1 ? path.resolve(args[rootIdx + 1]) : process.cwd();

    console.log('\n=== react-native-bspatch Setup ===');
    console.log(`  Project root: ${ROOT}`);

    const IOS_DIR = path.join(ROOT, 'ios');
    const ANDROID_DIR = path.join(ROOT, 'android');

    // ── iOS ──
    console.log('\n[iOS]');

    // project.pbxproj (ignore CocoaPods project file)
    const pbxprojFiles = findFile(IOS_DIR, (name, fullPath) => name === 'project.pbxproj' && !fullPath.includes('Pods'));
    if (pbxprojFiles.length === 0) {
        console.log('  ⚠  No project.pbxproj found. Is this an iOS project?');
    } else {
        const pbxproj = pbxprojFiles[0];
        patchFile(pbxproj, 'project.pbxproj (remove legacy bundle capture)', removePbxprojSnippet);
    }

    // AppDelegate.swift
    const appDelegateFiles = findFile(IOS_DIR, (name) => name === 'AppDelegate.swift');
    if (appDelegateFiles.length === 0) {
        console.log('  ⚠  No AppDelegate.swift found.');
    } else {
        patchFile(appDelegateFiles[0], 'AppDelegate.swift', patchAppDelegate);
    }

    // Ensure ios/output/ exists
    const outputDir = path.join(IOS_DIR, 'output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log('  ✓  Created ios/output/ directory');
    }

    // ── Android ──
    console.log('\n[Android]');
    const mainAppFiles = findFile(ANDROID_DIR, (name) => name === 'MainApplication.kt');
    if (mainAppFiles.length === 0) {
        console.log('  ⚠  No MainApplication.kt found. Is this an Android project?');
    } else {
        patchFile(mainAppFiles[0], 'MainApplication.kt', patchMainApplication);
    }

    const appGradleFiles = findFile(path.join(ANDROID_DIR, 'app'), (name) => name === 'build.gradle');
    if (appGradleFiles.length === 0) {
        console.log('  ⚠  No android/app/build.gradle found.');
    } else {
        patchFile(appGradleFiles[0], 'android/app/build.gradle (remove legacy bundle capture)', removeAppBuildGradleSnippet);
    }

    // Ensure android/output/ exists
    const androidOutputDir = path.join(ANDROID_DIR, 'output');
    if (!fs.existsSync(androidOutputDir)) {
        fs.mkdirSync(androidOutputDir, { recursive: true });
        console.log('  ✓  Created android/output/ directory');
    }

    console.log('\n=== Setup Complete ===');
    console.log('Next: release the app to the store (v1), then publish OTA updates with: npx react-native-bspatch\n');
}

main();
