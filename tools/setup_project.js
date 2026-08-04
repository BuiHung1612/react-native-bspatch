#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// react-native-bspatch Setup Script
//
// Automatically injects OTA integration into a React Native project:
//   - iOS:     Patches project.pbxproj (Xcode build phase bundle sync)
//              Patches AppDelegate.swift (import + bundleURL override)
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

const XCODE_BUNDLE_SYNC_SNIPPET = [
    '',
    '# [react-native-bspatch] Sync compiled bundle to output/ for OTA builds',
    'DEST_FILE="$PROJECT_DIR/output/main.jsbundle"',
    'BUNDLE_RESULT="$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/main.jsbundle"',
    '',
    'if [ -f "$BUNDLE_RESULT" ]; then',
    '  mkdir -p "$(dirname \\"$DEST_FILE\\")"',
    '  cp "$BUNDLE_RESULT" "$DEST_FILE"',
    '  echo "Bundle synced to $DEST_FILE"',
    'else',
    '  echo "Bundle not found at $BUNDLE_RESULT (skipping sync)"',
    'fi',
].join('\\n');

// The escaped version as it appears in pbxproj shellScript value
const XCODE_BUNDLE_SYNC_MARKER = 'react-native-bspatch] Sync compiled bundle to output/';

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

// ── iOS: project.pbxproj ─────────────────────────────────────────────────────

function patchPbxproj(content) {
    // Already patched?
    if (content.includes(XCODE_BUNDLE_SYNC_MARKER)) return content;

    // Search by phase name
    const nameIdx = content.indexOf('name = "Bundle React Native code and images";');
    if (nameIdx !== -1) {
        const shellScriptIdx = content.indexOf('shellScript = "', nameIdx);
        if (shellScriptIdx !== -1) {
            const endIdx = content.indexOf('";', shellScriptIdx + 15);
            if (endIdx !== -1) {
                return (
                    content.slice(0, endIdx) +
                    XCODE_BUNDLE_SYNC_SNIPPET +
                    content.slice(endIdx)
                );
            }
        }
    }

    console.log('    ⚠  Could not find "Bundle React Native code and images" build phase in project.pbxproj.');
    return content;
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
        // Find getDefaultReactHost(... call and inject jsBundleFilePath param
        // Look for closing paren of getDefaultReactHost block
        const hostCallRegex = /getDefaultReactHost\s*\(\s*([\s\S]*?)\)/m;
        const hostMatch = result.match(hostCallRegex);
        if (hostMatch) {
            // Insert before the closing paren
            const closeIdx = hostMatch.index + hostMatch[0].length - 1;
            result =
                result.slice(0, closeIdx) +
                ',\n      ' + ANDROID_JS_BUNDLE + '\n    ' +
                result.slice(closeIdx);
            changed = true;
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
        patchFile(pbxproj, 'project.pbxproj (Xcode build phase)', patchPbxproj);
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

    console.log('\n=== Setup Complete ===');
    console.log('Next steps:');
    console.log('  1. iOS: Run Xcode build once to populate ios/output/main.jsbundle');
    console.log('         (or run: yarn ota:init --platform ios)');
    console.log('  2. Android: Run: yarn ota:init --platform android');
    console.log('  3. Then: yarn ota:build to start publishing OTA updates\n');
}

main();
