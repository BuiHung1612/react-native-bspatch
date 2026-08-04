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

export enum OtaStorageType {
    /** Custom storage server (primary) */
    CUSTOM = 'CUSTOM',
    /** GitHub Releases — public or token-authenticated */
    GITHUB = 'GITHUB',
    /** GitHub Raw repository storage */
    GITHUB_RAW = 'GITHUB_RAW',
}

export type OtaPatch = {
    /** Unique ID: `v{from}-to-v{to}` */
    id: string;
    /** Human-readable label shown in UI */
    label: string;
    /** App version this patch belongs to */
    appVersion: string;
    /** Release tag (legacy, keep for type compatibility) */
    releaseTag?: string;
    /** Filename on the server (e.g. "v1-to-v3.patch") */
    filename: string;
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
    /** URL for full bundle download (fallback when patch fails) */
    fullBundleUrl?: string;
    /** Whether the patch/bundle is gzip compressed */
    compressed?: boolean;
    /** HMAC-SHA256 signature for security verification */
    signature?: string;
    /** Whether this update is mandatory */
    mandatory?: boolean;
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

export type OtaRemotePatch = {
    version: number;
    minAppVersion: string;
    patchUrl: string;
    bundleHash: string;
    baseHash: string;
    mandatory: boolean;
};

export type OtaMetadata = {
    currentVersion: number;
    previousVersions: number[];
    rollbackCount: number;
    lastLaunchSuccessful: boolean;
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
    wifiOnly?: boolean;
};

export type OtaConfig = {
    /** Current app versionName (e.g. "1.0.0") */
    appVersion: string;
    /** Initial version baked into the APK (usually 1) */
    baseAppVersion: number;
    /** Default patches if manifest fetch fails */
    bundledPatches?: OtaPatch[];

    /** Enterprise configurations */
    updateMode?: OtaUpdateMode;
    maxRollback?: number;
    network?: OtaNetworkStrategy;

    /** Telemetry: structured event callback for analytics */
    onEvent?: OtaEventCallback;
    /** Public key for signature verification (base64) */
    publicKey?: string;
    /** Base URL for the shared hashed asset store (e.g. a GitHub release URL) */
    assetBaseUrl?: string;

    /** Storage strategy */
    storageType?: OtaStorageType;

    /** GitHub Releases configuration (used when storageType === GITHUB) */
    githubRelease?: {
        /** Owner / repo in the format "owner/repo" */
        repo: string;
        /** Tag name of the release to fetch updates from */
        tag: string;
        /**
         * Path inside the release where ota_registry.json lives.
         * If your release contains the file at root, set to "ota_registry.json".
         * If it's inside a folder "ota/", set to "ota/ota_registry.json".
         */
        registryPath?: string;
        /**
         * Optional GitHub personal access token for private repos or higher rate limits.
         * For public repos this is optional.
         */
        token?: string;
        /**
         * Asset base URL for content-addressed assets.
         * Supports CDN URLs (jsDelivr, GitHub raw) or a custom base.
         * Example: "https://cdn.jsdelivr.net/gh/owner/repo@tag/assets"
         */
        assetBaseUrl?: string;
    };

    /** Custom storage server configuration */
    customServer?: {
        baseUrl: string;
        username: string;
        password: string;
        channel: string;
        baseFolder?: string;
        useMinio?: boolean;
        /** Override default API endpoints for non-standard servers */
        endpoints?: {
            /** Auth login endpoint (default: /public/authen/login) */
            login?: string;
            /** Generate download link endpoint (default: /api/minio/gen-download-link) */
            genDownloadLink?: string;
            /** Direct file download endpoint (default: /files/downloadStreamFile) */
            downloadFile?: string;
        };
    };

    /** Storage provider instance (optional, defaults to CustomStorageProvider) */
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
    applyUpdate: () => Promise<void>;
    resetToFactory: () => Promise<void>;
    markAsHealthy: () => Promise<void>;
    checkUpdate: () => Promise<void>;
};
