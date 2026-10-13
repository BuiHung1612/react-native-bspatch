# react-native-bspatch

Premium OTA update solution for React Native using **TurboModules** + **bsdiff binary patching**. Delivers significantly smaller delta updates compared to full bundle replacement.

## Features

- **Binary delta patches** — after the first OTA, clients download only the diff from the OTA bundle they already run (typically a few hundred KB)
- **POSIX `mmap()` Zero-Copy Engine** — patches directly in mapped pages, saving ~85–90% heap RAM
- **ARM NEON SIMD Fast-Path** — vectorized diff patching via Clang SIMD
- **Silent Background Updates** — download and apply updates completely in the background; smoothly activates on next launch or app backgrounding
- **Auto Native Version Detection** — auto-detects `versionName` (Android) and `CFBundleShortVersionString` (iOS); no manual version sync in JS
- **Asymmetric Cryptography (RSA & ECDSA)** — sign patches on server/CI with Private Key; client verifies with Public Key (zero secret leakage)
- **Shorebird-style CLI** — `patch android|ios`, release version read from the native project and confirmed with one Enter
- **One-Command Version Synchronization** — `react-native-bspatch version <x.y.z>` syncs `package.json`, Android `build.gradle`, and iOS Xcode project
- **Full bundle for the first OTA** — store installs (and clients outside the patch window, or whose patch fails) download the complete bundle; no base-bundle capture needed
- **Atomic bundle swap** — never leaves the app in a broken state
- **Crash detection + auto-rollback** — native-side protection runs **before** JS boots; if the updated bundle crashes, the app automatically rolls back to the previous version
- **Integrity verification** — SHA-256 hash check on both source bundle and result bundle
- **Disk Garbage Collection** — automatically removes obsolete bundle versions and dangling temporary files
- **Content-addressed asset store** — images/assets downloaded once per content hash and redirected via `setCustomSourceTransformer`
- **Structured telemetry** — all OTA events forwarded to your analytics via `onEvent` callback
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

No additional steps — auto-linked via CocoaPods.

---

## Quick Start

### 1. Wrap your app with `OtaProvider`

```tsx
import { OtaProvider, OtaUpdateMode } from 'react-native-bspatch';

const config = {
  // appVersion is optional! Auto-detected from native (versionName / CFBundleShortVersionString)
  baseAppVersion: 1,          // OTA version baked into the first APK/IPA (usually 1)
  updateMode: OtaUpdateMode.BACKGROUND_DOWNLOAD, // Silent download without interrupting user
  allowDebugUpdates: false,   // default: OTA is blocked in __DEV__
  customServer: {
    baseUrl: Config.OTA_BASE_URL!,  // public storage URL (R2 / GitHub raw), no fallback
    channel: Config.ENVIRONMENT!,   // flavor: development / staging / production
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
import { useOta, OtaStatus } from 'react-native-bspatch';

function UpdateBanner() {
  const { status, currentVersion, latestVersion, isUpdateReady, reloadBundle, applyUpdate } = useOta();

  if (isUpdateReady) {
    return (
      <Button
        title="Update downloaded! Restart to apply"
        onPress={reloadBundle}
      />
    );
  }

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
  /**
   * Current app versionName (e.g. "1.0.2").
   * OPTIONAL: If omitted, auto-detected from native app:
   *   - Android: PackageInfo.versionName
   *   - iOS: CFBundleShortVersionString
   */
  appVersion?: string;

  /**
   * OTA version number baked into the APK/IPA at build time.
   * Must match the version field in your server's ota_registry.json.
   * Usually starts at 1.
   */
  baseAppVersion: number;

  /**
   * Allow OTA checks and patch application while React Native is running in
   * development mode (`__DEV__`).
   * Default: false
   */
  allowDebugUpdates?: boolean;

  /**
   * When to check / apply updates.
   * - MANUAL: call checkUpdate() / applyUpdate() manually
   * - ON_APP_START: check and apply automatically on cold start
   * - ON_APP_FOREGROUND: check when app returns to foreground
   * - BACKGROUND_DOWNLOAD: download and patch in background; applies on next launch or app backgrounding
   */
  updateMode?: OtaUpdateMode;

  /** Network retry and timeout settings */
  network?: {
    retry?: number;       // max retry attempts (default: 3)
    timeoutMs?: number;   // request timeout in ms (default: 30000)
  };

  /**
   * Optional telemetry callback — all OTA lifecycle events are forwarded here.
   * Use it to pipe events to your analytics service.
   */
  onEvent?: (entry: OtaLogEntry) => void;

  /**
   * SPKI public key (PEM or base64, RSA or EC P-256) for signature verification.
   * When set, unsigned or wrongly signed patches/bundles are rejected.
   * Recommended for production to prevent MITM attacks.
   */
  publicKey?: string;

  /** Custom storage provider. Omit to use the default static-host provider. */
  storage?: OtaStorageProvider;

  /**
   * Static storage layout (public, read-only — never credentials). Required unless
   * `storage` is set; invalid values disable OTA (red box in __DEV__), no fallback.
   */
  customServer?: {
    baseUrl: string;      // R2 public URL, CDN, or https://raw.githubusercontent.com/<owner>/<repo>/<branch>
    channel: string;      // flavor
    baseFolder?: string;  // default: 'ota'
  };
};
```

### OtaUpdateMode values

```ts
enum OtaUpdateMode {
  MANUAL              = 'MANUAL',              // No auto behavior
  ON_APP_START        = 'ON_APP_START',        // Check + apply on every cold start
  ON_APP_FOREGROUND   = 'ON_APP_FOREGROUND',   // Check when app returns to foreground
  BACKGROUND_DOWNLOAD = 'BACKGROUND_DOWNLOAD', // Silent download; applies on next start or app backgrounding
}
```

### Debug builds

For safety, OTA checks and patch application are disabled by default while React Native runs in `__DEV__`.

If you explicitly want to test OTA inside a debug build, set:

```ts
allowDebugUpdates: true
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
              "id": "full-to-v3-production-android",
              "appVersion": "1.0.0",
              "fromVersion": 1,
              "toVersion": 3,
              "bundleHash": "sha256_of_v3_bundle",
              "platform": "android",
              "fullBundleUrl": "bundle_1.0.0_v3_android_production.hbc"
            },
            {
              "id": "v2-to-v3-production-android",
              "appVersion": "1.0.0",
              "filename": "patch_1.0.0_v2_to_v3_production_android.patch",
              "fromVersion": 2,
              "toVersion": 3,
              "baseHash": "sha256_of_v2_bundle",
              "bundleHash": "sha256_of_v3_bundle",
              "platform": "android",
              "fullBundleUrl": "bundle_1.0.0_v3_android_production.hbc"
            }
          ]
        }
      }
    }
  }
}
```

Every version has one full-bundle entry (no `filename`) plus patches from the last 5 OTA versions. The client applies the patch whose `fromVersion` is the OTA version installed on the device; otherwise (store build = v1, too far behind, or patch failure) it installs `fullBundleUrl`. The store bundle is never a patch source, so it never has to match byte-for-byte.

---

## Bundle Resolution & Rollback

### How it works

The native `OtaBundleResolver` runs **before JS boots** on every cold start:

```
1. Read metadata.json
2. If lastLaunchSuccessful == false → rollback to previous version
3. If currentVersion == baseAppVersion → use APK/IPA bundle
4. Otherwise → load OTA bundle from ota/v{version}/index.android.bundle (or main.jsbundle)
5. Unless this version is already verified: mark lastLaunchSuccessful = false (pending)
6. JS boots → OtaProvider renders the app → marks the running version healthy + verified
7. If that never happens (crash on load or first render) → next boot sees false → rolls back
   and records the version in failedVersions so it is never re-applied
8. A verified version is never rolled back later (a crash after it rendered is an app bug,
   and killing the app during a download must not discard a good bundle)
```

This means crash protection is **native-side and zero-cost** — it doesn't require JS to run first.

---

## Custom Storage Provider

The default provider (`GitHubRawStorageProvider`) reads any public static host with the `customServer` layout — Cloudflare R2, GitHub raw, a CDN. Implement the interface only for a backend that needs something else (signed URLs, an API):

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
  isUpdateReady,    // True if background update is downloaded and ready
  applyUpdate,      // () => Promise<void> — download and apply update immediately
  resetToFactory,   // () => Promise<void> — wipe OTA state, reload APK/IPA
  markAsHealthy,    // () => Promise<void> — manually mark launch OK
  checkUpdate,      // () => Promise<void> — manual update check
  reloadBundle,     // () => void — immediately reload JS bundle to apply ready update
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

### Commands

```bash
npx react-native-bspatch setup                      # once: wire OtaBundleResolver into the app
npx react-native-bspatch version 1.0.5              # set native version (package.json, Gradle, Xcode)
# … release 1.0.5 to the stores (this is OTA v1) …
npx react-native-bspatch patch android              # build + publish the next OTA
npx react-native-bspatch patch ios --flavor staging
npx react-native-bspatch patch                      # both platforms (versions must match)
npx react-native-bspatch reset --flavor staging --push   # wipe this release's OTAs
```

| Option | Default | Description |
|---|---|---|
| `android` / `ios` | both | Platform to patch |
| `--flavor <name>` | `dev` | Channel (`dev`→`development`, `prod`→`production`) |
| `--release-version <x.y.z>` | read from `versionName` / `MARKETING_VERSION`, confirmed by prompt | Store release the OTA targets |
| `-y` | | Skip the prompt, use the detected version |

The release version is read from the native project (`versionName` / `MARKETING_VERSION`) and confirmed in a prompt — Enter keeps it. `-y` or `--release-version` skip the prompt (CI). Every patch ships a full bundle plus bsdiff patches from the last 5 OTA versions; v1 (the store build) is never a patch source, so nothing has to be captured from the store binary.

### How It Works

1. **Bundle** — `npx react-native bundle` + `hermesc` generate Hermes bytecode (`.hbc`), uploaded as the version's full bundle.
2. **Assets** — Every asset is copied to the content-addressed `asset-store/` (`{sha256}.{ext}`) and listed in the per-version manifest. Clients download each hash once and reuse it across versions.
3. **Patch** — `bsdiff` generates a delta from each of the last 5 OTA bundles (v2+) to the new one.
4. **Registry** — Updates `ota_registry.json` with new `baseHash`, `bundleHash`, and asset manifest URL for each platform/channel.
5. **Upload** — Uploads bundles, patches, and asset store to the configured server.

### One-time Setup

```bash
# 1. Patch AppDelegate.swift / MainApplication.kt
npx react-native-bspatch setup

# 2. Release your app to App Store / Google Play (this is v1)

# 3. For each OTA update:
npx react-native-bspatch patch android
npx react-native-bspatch patch ios
```

### Environment Variables

The build reads two files from the project root:

| File | Contents | Read by the app? |
|---|---|---|
| `.env.<flavor>` (`.env.development`, `.env.staging`, ...) | `OTA_BASE_URL` | **Yes** — react-native-config bakes it into the APK/IPA |
| `.env.ota` | Upload secrets (`OTA_R2_*`) | No |

> [!CAUTION]
> Never put upload secrets in `.env.<flavor>`: react-native-config ships every key of that file inside the app binary.

The app and the build share `OTA_BASE_URL` from `.env.<flavor>`, so they can't drift apart:

```ts
customServer: {
  baseUrl: Config.OTA_BASE_URL!,   // no fallback: OTA is disabled (red box in dev) if missing
  channel: Config.ENVIRONMENT!,
},
```

Builds publish to **Cloudflare R2** when `.env.ota` sets `OTA_R2_BUCKET`, otherwise to a GitHub storage repository (auth via `gh auth token` / `GH_TOKEN` / `GITHUB_TOKEN`).

R2 setup: enable the bucket's Public Development URL (or a custom domain) and create an R2 API token with *Object Read & Write* on the bucket. Uploads use `curl --aws-sigv4`, no extra CLI. Bundles, patches and assets are uploaded once with an immutable cache header; `ota_registry.json` is uploaded last with `no-cache`.

```bash
# .env.<flavor>
OTA_BASE_URL=https://pub-xxxx.r2.dev

# .env.ota
OTA_R2_ACCOUNT_ID=...
OTA_R2_BUCKET=...
OTA_R2_ACCESS_KEY_ID=...
OTA_R2_SECRET_ACCESS_KEY=...
```

| Variable | File | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `OTA_BASE_URL` | `.env.<flavor>` | Yes | - | Public base URL (R2 public URL, or `https://raw.githubusercontent.com/<owner>/<repo>/<branch>`) |
| `OTA_FOLDER` | `.env.<flavor>` | No | `ota` | Folder prefix in storage; only set it to share one bucket/repo with other data (and set `customServer.baseFolder` to match) |
| `OTA_R2_*` | `.env.ota` | For R2 | - | `ACCOUNT_ID`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` |
| `OTA_PRIVATE_KEY` | shell env (CI) | No | - | PEM private key; locally keep `ota_private_key.pem` in the project root instead (`.env.ota` values are single-line) |

Keep both files out of git (`.env.*` in `.gitignore`).

---

## Security & Asymmetric Signing

In production, enabling patch signature verification is **strongly recommended** to prevent man-in-the-middle (MITM) attacks and malicious patch injection.

`react-native-bspatch` supports **bank-grade asymmetric cryptography (RSA-2048 & ECDSA P-256)**:
- **Private Key (`ota_private_key.pem`)**: Stored **only** on your build machine / CI server. Used to sign patch files. Never shipped inside the client app.
- **Public Key (`ota_public_key.pem`)**: Embedded in your client app via `config.publicKey`. Even if a bad actor reverse-engineers your APK/IPA, they cannot forge updates without the Private Key.

### 1. Generate Keypair (One-Time)

```bash
# Generate RSA-2048 keypair
node ./node_modules/react-native-bspatch/tools/generate_keys.js
# Or generate ECDSA (P-256) keypair:
node ./node_modules/react-native-bspatch/tools/generate_keys.js --type ec
```

This creates:
- `ota_private_key.pem` ➔ **Add to `.gitignore`!** Keep safe on CI.
- `ota_public_key.pem` ➔ Copy the public key string into your app config:

```ts
const otaConfig: OtaConfig = {
  publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...',
  ...
};
```

### 2. Automated Signing at Build Time

When you run `tools/build_ota.sh`, it automatically searches for `ota_private_key.pem` (or the `OTA_PRIVATE_KEY` environment variable). If found, it **signs each patch (`signature`) and the resulting bundle (`bundleSignature`) with SHA-256** and injects the signatures into `ota_registry.json`. The bundle signature is checked on both the patch path and the full-bundle fallback. If the key is present but a file can't be signed, the build fails.

On the client device:
- **Android**: Uses Android Security Provider (`SHA256withRSA` / `SHA256withECDSA`).
- **iOS**: Uses Apple Security framework (`SecKeyVerifySignature`).
- **Fail closed**: when `publicKey` is set, a missing or invalid signature rejects the update. HMAC/symmetric keys are no longer supported (the public key ships in the app, so it can't be a secret).

---

## Version Management

### 1. Zero Manual Sync in JS
`config.appVersion` is **optional**. The library automatically queries the native app version at runtime:
- Android: `PackageInfo.versionName`
- iOS: `CFBundleShortVersionString`

> **Fail-Fast Safety:** The library never falls back silently to `"1.0.0"`. If native version information is missing or corrupted, it immediately throws a descriptive error to prevent version mismatches.

### 2. One-Command Version Sync
When releasing a new native binary version (e.g. `1.0.3`):

```bash
npx react-native-bspatch version 1.0.3
```

This updates `package.json`, `android/app/build.gradle` (`versionName`, increments `versionCode`) and `ios/*.xcodeproj/project.pbxproj` (`MARKETING_VERSION`, increments `CURRENT_PROJECT_VERSION`).

### 3. Release Version Confirmation
`patch android` reads `versionName`, `patch ios` reads `MARKETING_VERSION`, and asks for confirmation:

```text
  Release version for android [1.0.2]:
```

Press **Enter** to keep it or type another version. `-y` or `--release-version <x.y.z>` skip the prompt (CI).

---

## High-Performance Native Architecture

- **POSIX `mmap()` Zero-Copy Patching**: Unlike standard bspatch which allocates heap memory with `malloc()`, `react-native-bspatch` memory-maps the input and output files using `mmap()` and `MADV_SEQUENTIAL`. Memory overhead is reduced by **~85–90%**, virtually eliminating out-of-memory crashes on low-end devices.
- **SIMD Vectorization**: The inner patching loop includes `#pragma clang loop vectorize(enable)` for Clang ARM NEON 128-bit vectorization.
- **64KB Streaming Buffers**: File hashing and stream copying are upgraded to 64KB chunk sizes across Android and iOS.
- **Disk Garbage Collection**: Calling `markHealthy()` automatically deletes obsolete bundle versions and dangling `.tmp` files from disk, keeping app storage minimal.

## File Structure

```
react-native-bspatch/
├── src/
│   ├── index.ts                      # Public JS entry point
│   ├── NativeBsPatch.ts              # TurboModule spec
│   └── ota/
│       ├── otaCore.ts                # Pipeline: patch from installed OTA bundle, else full bundle
│       ├── otaMetadata.ts            # Locked metadata updates, health marking, disk GC
│       ├── otaLogger.ts              # Structured event telemetry
│       ├── otaAssetResolver.ts       # Image source interceptor + asset store
│       ├── OtaProvider.tsx           # React provider + update modes
│       ├── types.ts
│       └── storage/
│           └── GitHubRawStorage.ts   # Default provider: any static host (R2, GitHub raw, CDN)
├── android/src/main/java/vn/reactnativebspatch/
│   ├── BsPatchModule.kt              # applyPatch, verifySignature, reload
│   └── OtaBundleResolver.kt          # Bundle resolution + crash rollback (before JS)
├── ios/
│   ├── RNBsPatch.mm                  # applyPatch, verifySignature, reload
│   └── OtaBundleResolver.swift       # Bundle resolution + crash rollback (before JS)
├── cpp/bsdiff/                       # bspatch (C, mmap)
└── tools/
    ├── cli.js                        # bin entry (Yarn Berry runs bins with node)
    ├── build_ota.sh                  # CLI: patch / reset / setup / version
    ├── upload_ota.sh                 # Upload to Cloudflare R2 or a GitHub storage repo
    ├── update_registry.js            # Writes ota_registry.json entries + signatures
    ├── setup_project.js              # AppDelegate / MainApplication wiring
    ├── bump_version.js               # Native version sync
    └── generate_keys.js              # RSA / EC signing keypair
```

---

## Known Limitations

- The first OTA after a store install, and clients more than 5 OTA versions behind, download the full bundle (patches are only built from the last 5 OTA versions)
- Health is confirmed when the app first renders; a crash after that is not rolled back
- OTA version numbers are shared by both platforms of a flavor, so `patch android` then `patch ios` gives iOS the next number
- Asset redirection via `setCustomSourceTransformer` requires React Native **0.69+**
