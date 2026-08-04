# react-native-bspatch

Premium OTA update solution for React Native using **TurboModules** + **bsdiff binary patching**. Delivers significantly smaller delta updates compared to full bundle replacement.

## Features

- **Binary delta patches** — only download the diff between old and new bundle (typically 5–30% of full bundle size)
- **Full-bundle fallback** — if patch fails, automatically downloads the complete bundle
- **Atomic bundle swap** — never leaves the app in a broken state
- **Crash detection + auto-rollback** — native-side protection runs **before** JS boots; if the updated bundle crashes, the app automatically rolls back to the previous version
- **Integrity verification** — SHA-256 hash check on both source bundle and result bundle
- **HMAC signature verification** — optional patch signature check to prevent MITM attacks
- **Gzip decompression** — native gzip decompression on both Android and iOS (when `compressed: true`)
- **Content-addressed asset store** — images/assets downloaded per-version and redirected via `setCustomSourceTransformer`
- **Structured telemetry** — all OTA events forwarded to your analytics via `onEvent` callback
- **Version history** — keeps up to 3 previous versions for safe multi-step rollback
- **New Architecture ready** — built with TurboModules (no legacy Bridge)

---

## Requirements

- React Native **0.76+** (New Architecture enabled by default)
- `react-native-blob-util` — required peer dependency for file I/O

---

## Installation

```bash
npm install react-native-bspatch react-native-blob-util
cd ios && pod install
```

### Android

CMake will be invoked automatically via Gradle. Ensure `android/app/build.gradle` includes:

```groovy
android {
    defaultConfig {
        ndk {
            abiFilters "armeabi-v7a", "arm64-v8a", "x86", "x86_64"
        }
    }
}
```

### iOS

No additional steps — `react-native-bspatch` and its `SSZipArchive` dependency are auto-linked via CocoaPods.

---

## Quick Start

### 1. Wrap your app with `OtaProvider`

```tsx
import { OtaProvider } from 'react-native-bspatch';

const config = {
  appVersion: '1.0.0',        // matches versionName in build.gradle
  baseAppVersion: 1,          // OTA version baked into the first APK/IPA (usually 1)
  updateMode: OtaUpdateMode.MANUAL,
  customServer: {
    baseUrl: 'https://ota.yourcompany.com',
    username: 'your-user',
    password: 'your-pass',
    channel: 'production',
    baseFolder: 'bspatch',
    useMinio: false,
  },
};

export default function App() {
  return (
    <OtaProvider config={config}>
      {/* rest of your app */}
    </OtaProvider>
  );
}
```

### 2. Check for updates and apply

```tsx
import { useOta, OtaUpdateMode, OtaStatus } from 'react-native-bspatch';

function UpdateBanner() {
  const { status, currentVersion, latestVersion, checkUpdate, applyUpdate } = useOta();

  if (status === OtaStatus.UPDATE_AVAILABLE) {
    return (
      <Button
        title={`Update to V${latestVersion} →`}
        onPress={applyUpdate}
      />
    );
  }

  return <Text>Already up to date (V{currentVersion})</Text>;
}
```

---

## Configuration Reference

```ts
type OtaConfig = {
  /** Current app versionName, e.g. "1.0.0" */
  appVersion: string;

  /**
   * OTA version number baked into the APK/IPA at build time.
   * Must match the version field in your server's ota_registry.json.
   * Usually starts at 1.
   */
  baseAppVersion: number;

  /** Fallback patches used when manifest fetch fails */
  bundledPatches?: OtaPatch[];

  /**
   * When to check / apply updates.
   * - MANUAL: call checkUpdate() / applyUpdate() manually
   * - ON_APP_START: check automatically on every cold start
   * - ON_APP_FOREGROUND: check when app returns to foreground
   * - BACKGROUND_DOWNLOAD: check on start; download in background (coming soon)
   */
  updateMode?: OtaUpdateMode;

  /** Max rollback attempts before resetting to factory build (default: 3) */
  maxRollback?: number;

  /** Network retry and timeout settings */
  network?: {
    retry?: number;       // max retry attempts (default: 3)
    timeoutMs?: number;   // request timeout in ms (default: 30000)
    wifiOnly?: boolean;   // TODO (default: false)
  };

  /**
   * Optional telemetry callback — all OTA lifecycle events are forwarded here.
   * Use it to pipe events to your analytics service.
   */
  onEvent?: (entry: OtaLogEntry) => void;

  /**
   * Base64-encoded public key for HMAC-SHA256 patch signature verification.
   * Recommended for production to prevent MITM attacks.
   */
  publicKey?: string;

  /** Custom storage provider. Omit to use CustomStorageProvider. */
  storage?: OtaStorageProvider;

  /** Custom server configuration (used by CustomStorageProvider) */
  customServer?: {
    baseUrl: string;
    username: string;
    password: string;
    channel: string;
    baseFolder?: string;  // default: 'bspatch'
    useMinio?: boolean;
  };
};
```

### OtaUpdateMode values

```ts
enum OtaUpdateMode {
  MANUAL             = 'MANUAL',            // No auto behavior
  ON_APP_START       = 'ON_APP_START',      // Check + apply on every cold start
  ON_APP_FOREGROUND  = 'ON_APP_FOREGROUND', // Check when app returns to foreground
  BACKGROUND_DOWNLOAD = 'BACKGROUND_DOWNLOAD', // TODO: download in background
}
```

### OtaStatus values

| Status | Meaning |
|---|---|
| `IDLE` | Initial state |
| `CHECKING` | Fetching manifest |
| `UPDATE_AVAILABLE` | A newer version exists |
| `UP_TO_DATE` | Already on the latest version |
| `DOWNLOADING` | Downloading patch or full bundle |
| `APPLYING` | Applying binary patch or decompressing |
| `SYNCING_ASSETS` | Downloading version-specific assets |
| `SUCCESS` | Update applied; app is reloading |
| `ERROR` | Update failed |

---

## Server-Side Manifest Format

Your OTA server must expose a `ota_registry.json` at the configured path (e.g. `https://ota.yourcompany.com/bspatch/ota_registry.json`):

```json
{
  "apps": {
    "1.0.0": {
      "flavors": {
        "production": {
          "patches": [
            {
              "id": "v1-to-v2",
              "label": "Feature release",
              "appVersion": "1.0.0",
              "filename": "v1-to-v2.patch",
              "fromVersion": 1,
              "toVersion": 2,
              "baseHash": "sha256_of_v1_bundle",
              "bundleHash": "sha256_of_v2_bundle",
              "platform": "android",
              "compressed": false,
              "mandatory": false,
              "fullBundleUrl": "v2-full.zip"
            }
          ]
        }
      }
    }
  }
}
```

> **Important:** `baseHash` must be the exact SHA-256 of the bundle that users currently have installed (after OTA patching, not just the APK bundle). The most reliable way to get this is to record it **after** each successful patch application, store it server-side, and reference it as `baseHash` for the next patch in the chain.

---

## Bundle Resolution & Rollback

### How it works

The native `OtaBundleResolver` runs **before JS boots** on every cold start:

```
1. Read metadata.json
2. If lastLaunchSuccessful == false → rollback to previous version
3. If currentVersion == baseAppVersion → use APK/IPA bundle
4. Otherwise → load OTA bundle from ota/v{version}/index.android.bundle (or main.jsbundle)
5. Mark lastLaunchSuccessful = false (will reset to true when JS calls markAsHealthy)
6. JS boots → runs bootstrap → calls markAsHealthy()
7. If JS never calls markAsHealthy() (crash) → next boot sees false → rolls back
```

This means crash protection is **native-side and zero-cost** — it doesn't require JS to run first.

---

## Custom Storage Provider

The library ships with `CustomStorageProvider` for MinIO-based private servers. To use a different backend, implement the interface:

```ts
interface OtaStorageProvider {
  /** Fetch the list of available patches */
  fetchManifest(config: OtaConfig): Promise<OtaPatch[]>;

  /** Get a signed download URL for a patch or full bundle */
  getUpdateFileUrl(filename: string, config: OtaConfig): Promise<string>;

  /** Get a signed download URL for a content-addressed asset */
  getAssetUrl(hash: string, ext: string, config: OtaConfig): Promise<string>;
}
```

Pass your implementation via `config.storage`.

---

## API Reference

### `useOta()` — React hook (inside `OtaProvider`)

```ts
const {
  status,           // OtaStatus
  message,          // Human-readable status message
  progress,         // 0–100 download/progress percentage
  currentVersion,   // OTA version number currently running
  latestVersion,    // Highest version available on server
  pendingCount,     // Number of pending updates
  isChecking,       // True while fetching manifest
  metrics,          // OtaMetrics | null — timing/size data after update
  applyUpdate,      // () => Promise<void>
  resetToFactory,   // () => Promise<void> — wipe OTA state, reload APK/IPA
  markAsHealthy,    // () => Promise<void> — manually mark launch OK
  checkUpdate,      // () => Promise<void>
} = useOta();
```

### `applyPatch(oldPath, newPath, patchPath)` — Low-level

Applies a bsdiff patch directly. Used internally; available for advanced use cases.

```ts
import { applyPatch } from 'react-native-bspatch';
await applyPatch('/path/to/old.bundle', '/path/to/new.bundle', '/path/to/patch.patch');
```

### `markAsHealthy()` / `reloadBundle()` — Advanced

These are called automatically by `OtaProvider`. Only call manually if you manage OTA outside the provider.

---

## OTA Build Process

The library ships with an **automated build pipeline** (`tools/build_ota.sh`) that handles the entire release workflow: bundling, Hermes compilation, asset discovery, bsdiff patch generation, and server upload.

### Project Scripts

Add these to your `package.json` (or use the existing ones in this project):

```json
{
  "scripts": {
    "react-native-bspatch": "bash ./src/native_modules/react-native-bspatch/tools/build_ota.sh",
    "ota:setup":   "yarn react-native-bspatch setup",
    "ota:init":    "yarn react-native-bspatch base",
    "ota:build":   "yarn react-native-bspatch",
    "ota:clean":   "yarn react-native-bspatch reset"
  }
}
```

### Workflow

```
ota:setup ──► ota:init ──► ota:build ──► (ota:build ◄── repeat for each release)
   │             │            │
   │             │            └── 1. Bundle JS → Hermes bytecode (.hbc)
   │             │                2. Compare assets → generate asset-manifest-{ver}.json
   │             │                3. bsdiff against previous bundle → .patch files
   │             │                4. Upload to server + update ota_registry.json
   │             │                5. Write otaPatches.generated.ts for bundled patches fallback
   │             │
   │             └── First build only: creates base bundle from APK/IPA.
   │                                Stores base asset manifest so subsequent builds know
   │                                which assets are already in the APK and skip them.
   │
   └── Patches native integration into project files:
         • iOS: AppDelegate.swift — adds bundleURL() override
         • iOS: project.pbxproj — adds build-phase script to sync bundle → ios/output/
         • Android: MainApplication.kt — adds OtaBundleResolver.resolve() call
         Idempotent: safe to run multiple times; skips already-patched files.
```

### Build Commands

| Command | Action |
|---|---|
| `yarn ota:setup` | Inject OTA integration into AppDelegate.swift, MainApplication.kt, project.pbxproj. Run once per project. |
| `yarn ota:init` | First release: build base APK/IPA + bundle + base asset manifest. Creates `ota_registry.json`. |
| `yarn ota:build` | Subsequent releases: generate incremental .patch from previous bundle, upload to server, update registry. |
| `yarn ota:build --platform android` | Build Android only |
| `yarn ota:build --platform ios` | Build iOS only |
| `yarn ota:build --flavor staging` | Build with flavor "staging" (default: "dev") |
| `yarn ota:clean` | Wipe `ota_registry.json` + output files. Preserves base asset manifests so `ota:build` still works after clean. |

### How It Works

1. **Bundle** — `npx react-native bundle` generates Hermes bytecode (`.hbc`). iOS base build uses the Xcode-compiled bundle to guarantee byte-exact match with the IPA.
2. **Assets** — Compares against `base-assets_{platform}_{flavor}.json` (saved at `ota:init`). Unchanged assets are skipped; changed/new assets are copied to `asset-store/` and included in the per-version manifest.
3. **Patch** — `bsdiff` generates a binary delta from the previous bundle to the new one. The diff is typically 5–30% the size of a full bundle.
4. **Registry** — Updates `ota_registry.json` with new `baseHash`, `bundleHash`, and asset manifest URL for each platform/channel.
5. **Upload** — Uploads bundles, patches, and asset store to the configured server.

### One-time Setup

```bash
# 1. Add the npm scripts to package.json (or run directly)
bash ./src/native_modules/react-native-bspatch/tools/build_ota.sh setup

# 2. Initialize the first release (creates base APK + registry)
yarn ota:init
# Or per platform:
yarn ota:init --platform android   # Android only
yarn ota:init --platform ios       # iOS only

# 3. For each subsequent release:
yarn ota:build
```

### Environment Variables

The build script requires server credentials. You can provide them via:

**Option 1: `.env` file (recommended)**

Create a `.env` file in your **React Native project root** (not in the module directory):

```bash
# In your project root (e.g., /path/to/YourApp/)
OTA_USER=your-username
OTA_PASSWORD=your-password
```

The build script automatically loads `.env` from the project root.

**Option 2: Export environment variables**

```bash
export OTA_USER="your-username"
export OTA_PASSWORD="your-password"
yarn ota:build
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OTA_USER` | Yes | - | Server username |
| `OTA_PASSWORD` | Yes | - | Server password |
| `OTA_BASE_URL` | No | `https://sync-server.osp.com.vn` | Server base URL |
| `OTA_FOLDER` | No | `congplqg` | Base folder path |

> **Security Warning:** Never commit credentials to source control. The `.env` file is gitignored.

---

## Security Notes

- **PATCH verification is STRONGLY recommended in production.** Enable by setting `config.publicKey`. Without it, a MITM could serve a malicious patch.
- Signature verification uses SHA-256 hash comparison. For higher security, consider RSA/ECDSA signature verification.
- `markAsHealthy()` is called automatically by `OtaProvider`. If you use a custom integration, you **must** call it after successful JS bootstrap, or the native resolver will rollback on the next cold start.

---

## File Structure

```
src/native_modules/react-native-bspatch/
├── index.ts                          # Public JS entry point
├── src/
│   ├── NativeBsPatch.ts              # TurboModule TypeScript wrapper
│   └── ota/
│       ├── otaCore.ts               # Core pipeline: download → patch → fallback
│       ├── otaMetadata.ts           # Metadata load/save with race-condition guard
│       ├── otaLogger.ts             # Structured event telemetry
│       ├── otaAssetResolver.ts      # Image source interceptor + asset store
│       ├── OtaProvider.tsx           # React Context provider + auto-update logic
│       ├── types.ts                  # All TypeScript type definitions
│       └── storage/
│           ├── CustomStorage.ts        # MinIO-based storage implementation
│           └── GitHubReleaseStorage.ts # GitHub Releases storage (public / token-auth)
├── android/src/main/java/vn/reactnativebspatch/
│   ├── BsPatchModule.kt             # Native: applyPatch, unzip, extract, gzip
│   └── OtaBundleResolver.kt         # Native: bundle resolution + rollback
├── ios/
│   ├── RNBsPatch.mm                # Native iOS bridge + gzip decompress
│   └── OtaBundleResolver.swift      # Native iOS bundle resolution + rollback
├── cpp/
│   ├── CMakeLists.txt               # CMake build for bspatch C library
│   └── bsdiff/                      # bsdiff/bspatch source
└── tools/
    ├── build_ota.sh                # Main build pipeline: bundle → patch → upload
    ├── setup_project.js            # Idempotent project integration injector
    └── update_registry.js          # Updates ota_registry.json after each build
```

---

## Known Limitations

- `BACKGROUND_DOWNLOAD` mode is a stub — auto-update currently works in `MANUAL`, `ON_APP_START`, and `ON_APP_FOREGROUND` modes only
- Patch chain must be **sequential** (e.g. V1→V2→V3). The library resolves the best available direct patch for your current version; it does not chain multiple patches in a single update
- Asset redirection via `setCustomSourceTransformer` requires React Native **0.69+**
