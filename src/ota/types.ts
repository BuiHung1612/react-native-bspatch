/**
 * OTA Data Types
 */

import type { OtaEventCallback } from './otaLogger';

export interface OtaStorageProvider {
    /**
     * Fetch the list of available patches for the current configuration.
     */
    fetchManifest(config: OtaConfig): Promise<OtaPatch[]>;

    /**
     * Get a signed download URL for a version-specific update file (patch or full bundle).
     */
    getUpdateFileUrl(filename: string, config: OtaConfig): Promise<string>;

    /**
     * Get a signed download URL for a content-addressed asset.
     */
    getAssetUrl(hash: string, ext: string, config: OtaConfig): Promise<string>;
}

export enum OtaUpdateMode {
    MANUAL = 'MANUAL',
    ON_APP_START = 'ON_APP_START',
    ON_APP_FOREGROUND = 'ON_APP_FOREGROUND',
    BACKGROUND_DOWNLOAD = 'BACKGROUND_DOWNLOAD',
}

export type OtaPatch = {
    /** Unique ID: `v{from}-to-v{to}` */
    id: string;
    /** Human-readable label shown in UI */
    label: string;
    /** App version this patch belongs to */
    appVersion: string;
    /** Patch file on the server; absent on the full-bundle entry (installs `fullBundleUrl`) */
    filename?: string;
    /** Version the app must be at to apply this patch */
    fromVersion: number;
    /** Version this patch upgrades to */
    toVersion: number;
    /** Integrity hashes (optional for legacy support) */
    baseHash?: string;
    /** Hash of the bundle after patching */
    bundleHash?: string;
    /** Minimum native app version required (semver) */
    minAppVersion?: string;
    /** Full bundle file: used when there is no OTA bundle to patch from, or the patch fails */
    fullBundleUrl?: string;
    /** Size of the full bundle in bytes: download progress when it arrives Content-Encoded */
    bundleSize?: number;
    /** RSA/ECDSA SHA-256 signature (base64) of the patch file */
    signature?: string;
    /** RSA/ECDSA SHA-256 signature (base64) of the resulting bundle */
    bundleSignature?: string;
    /** URL to the asset manifest JSON for this version */
    assetManifestUrl?: string;
    /** SHA-256 of the asset manifest file (covered by entrySignature) */
    assetManifestHash?: string;
    /** Signature (base64) of entryPayload(entry): required when a public key is set */
    entrySignature?: string;
    /** Target platform for this patch */
    platform?: string;
    /** Flavor/channel for this patch */
    flavor?: string;
    /** How fullBundleUrl is compressed ('gzip' | 'bz2'); absent = raw .hbc */
    fullBundleCompression?: string;
    /** Native runtime fingerprint the bundle was built against: installs only on a matching binary */
    runtimeFingerprint?: string;
    /** Hermes bytecode version of the bundle: installs only on a runtime that reads it */
    hermesBytecodeVersion?: number;
    /** Client features this entry needs; a client missing one skips the entry */
    requires?: string[];

    // ── Release controls (not signed: they can only hold an update back or release a signed one) ──
    /** Kill switch: no client installs this version */
    disabled?: boolean;
    /** Staged rollout: share of installs (0-100) that get this version, by a stable per-install bucket */
    rolloutPercent?: number;
    /** QA: only these install IDs (useOta().installId) get this version */
    allowInstallIds?: string[];
    /** Apply as soon as it's ready instead of on the next launch (BACKGROUND_DOWNLOAD) */
    mandatory?: boolean;
};

/**
 * A single content-addressed asset from the OTA asset store.
 */
export type OtaAsset = {
    /** SHA-256 hash of the file (used as filename: `{hash}.{ext}`) */
    hash: string;
    /** File extension without dot (e.g. "jpg", "png") */
    ext: string;
    /** Original relative path as Metro knows it (e.g. "drawable-mdpi/assets_images_foo.jpg") */
    originalPath: string;
};

export type OtaMetadata = {
    currentVersion: number;
    previousVersions: number[];
    rollbackCount: number;
    lastLaunchSuccessful: boolean;
    /** Native app version the OTA bundles were built for; native resolver drops OTA state when it changes */
    appVersion?: string;
    /** Versions that crashed on boot and were rolled back; never re-applied */
    failedVersions?: number[];
    /** Last version that launched and rendered successfully; the native resolver never rolls it back */
    verifiedVersion?: number;
    /** Unverified launches of currentVersion so far; native rolls back once it reaches the limit (3) */
    launchAttempts?: number;
};

export type OtaMetrics = {
    patchSizeKB: number;
    downloadMs: number;
    applyMs: number;
    totalMs: number;
    fromCache: boolean;
};

export type OtaNetworkStrategy = {
    retry?: number;
    timeoutMs?: number;
    /** Automatic downloads only on Wi-Fi/Ethernet (manual applyUpdate always downloads) */
    wifiOnly?: boolean;
};

export type OtaConfig = {
    /** Current app versionName (e.g. "1.0.0"). If omitted, auto-detected from native app. */
    appVersion?: string;
    /** Initial version baked into the APK (usually 1) */
    baseAppVersion: number;
    /**
     * Allow OTA checks and patch application while React Native is running in
     * development mode (`__DEV__`). Disabled by default for safety.
     */
    allowDebugUpdates?: boolean;

    /** Enterprise configurations */
    updateMode?: OtaUpdateMode;
    network?: OtaNetworkStrategy;

    /** Telemetry: structured event callback for analytics */
    onEvent?: OtaEventCallback;
    /**
     * POSTs every OTA event as JSON to `url` (fire-and-forget), with installId, platform,
     * appVersion, appBuild, runtimeFingerprint, flavor and the running OTA version attached.
     */
    telemetry?: { url: string; headers?: Record<string, string> };
    /**
     * Minimum time between automatic update checks (app start / foreground / checkUpdate()).
     * checkUpdate({ force: true }) ignores it. Default 10 minutes.
     */
    minCheckIntervalMs?: number;
    /**
     * SPKI public key(s), PEM or base64 (comma-separated for several), for RSA/ECDSA
     * signature verification. Defaults to the keys `patch` embedded in the app.
     * When there is a key, unsigned or wrongly signed updates are rejected.
     */
    publicKey?: string;

    /**
     * Static storage layout read by the default provider: `${baseUrl}/${baseFolder}/...`.
     * Any static host/CDN serving the same layout works (e.g. a public bucket).
     * Read-only and public: never put upload credentials here, they ship inside the app.
     */
    customServer?: {
        /** R2 public URL, e.g. https://pub-<id>.r2.dev or a custom domain */
        baseUrl: string;
        channel: string;
        baseFolder?: string;
        /** Extra headers on every request (registry, bundles, assets), e.g. auth for a private server */
        headers?: Record<string, string>;
    };

    /** Storage provider instance (optional, defaults to R2StorageProvider) */
    storage?: OtaStorageProvider;
};

export enum OtaStatus {
    IDLE = 'IDLE',
    CHECKING = 'CHECKING',
    UPDATE_AVAILABLE = 'UPDATE_AVAILABLE',
    UP_TO_DATE = 'UP_TO_DATE',
    DOWNLOADING = 'DOWNLOADING',
    APPLYING = 'APPLYING',
    SYNCING_ASSETS = 'SYNCING_ASSETS',
    SUCCESS = 'SUCCESS',
    ERROR = 'ERROR',
}

export type OtaState = {
    status: OtaStatus;
    message: string;
    progress: number; // 0-100
    currentVersion: number;
    latestVersion: number;
    pendingCount: number;
    isChecking: boolean;
    metrics: OtaMetrics | null;
    /** True if a background update has been downloaded and prepared silently */
    isUpdateReady: boolean;
    /** The ready update is marked mandatory: it reloads as soon as the app is in the foreground */
    isMandatory: boolean;
    /** Stable random ID of this install (rollout bucket, QA allow-lists, telemetry) */
    installId: string;
    applyUpdate: () => Promise<void>;
    /** Installs and reloads `version` from the last checked manifest (full bundle, or a patch from the current version) */
    applyVersion: (version: number) => Promise<void>;
    /**
     * Installs and reloads exactly this registry entry (e.g. a row of a version list): its
     * patch when it starts from the running version, else its full bundle. Ignores the kill
     * switch, rollout and QA list; still refuses entries for other native code or Hermes.
     */
    applyEntry: (entry: OtaPatch) => Promise<void>;
    resetToFactory: () => Promise<void>;
    markAsHealthy: () => Promise<void>;
    /** Checks now unless the last check was under minCheckIntervalMs ago (force: always) */
    checkUpdate: (options?: { force?: boolean }) => Promise<void>;
    /** Reload the React Native JS bundle immediately to apply downloaded update */
    reloadBundle: () => void;
};
