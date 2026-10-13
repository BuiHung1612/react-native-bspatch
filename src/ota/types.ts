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
    /** RSA/ECDSA SHA-256 signature (base64) of the patch file */
    signature?: string;
    /** RSA/ECDSA SHA-256 signature (base64) of the resulting bundle */
    bundleSignature?: string;
    /** URL to the asset manifest JSON for this version */
    assetManifestUrl?: string;
    /** Target platform for this patch */
    platform?: string;
    /** Flavor/channel for this patch */
    flavor?: string;
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
     * SPKI public key (PEM or base64) for RSA/ECDSA signature verification.
     * When set, patches and bundles without a valid signature are rejected.
     */
    publicKey?: string;

    /**
     * Static storage layout read by the default provider: `${baseUrl}/${baseFolder}/...`.
     * Any static host/CDN serving the same layout works (e.g. a public bucket).
     * Read-only and public: never put upload credentials here, they ship inside the app.
     */
    customServer?: {
        /** e.g. https://raw.githubusercontent.com/<owner>/<repo>/<branch> */
        baseUrl: string;
        channel: string;
        baseFolder?: string;
    };

    /** Storage provider instance (optional, defaults to GitHubRawStorageProvider) */
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
    applyUpdate: () => Promise<void>;
    resetToFactory: () => Promise<void>;
    markAsHealthy: () => Promise<void>;
    checkUpdate: () => Promise<void>;
    /** Reload the React Native JS bundle immediately to apply downloaded update */
    reloadBundle: () => void;
};
