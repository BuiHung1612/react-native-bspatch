/**
 * Core OTA Logic (Stateless)
 *
 * Responsibilities:
 *  - Download patches with retry
 *  - Verify integrity (SHA-256 hash)
 *  - Verify security (HMAC signature)
 *  - Handle gzip decompression
 *  - Apply binary patch (bsdiff)
 *  - Atomic bundle swap
 *  - Full bundle fallback on failure
 *  - Structured telemetry logging
 */

import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import CryptoJS from 'crypto-js';
import NativeBsPatch from '../NativeBsPatch';
import { createOtaLogger, OtaEvent } from './otaLogger';
import {
    ensureOtaDir,
    getBundlePath,
    loadMetadata,
    registerNewVersion,
    saveMetadata,
} from './otaMetadata';
import { CustomStorageProvider } from './storage/CustomStorage';
import { GitHubReleaseStorageProvider } from './storage/GitHubReleaseStorage';
import { GitHubRawStorageProvider } from './storage/GitHubRawStorage';
import {
    OtaStatus,
    OtaStorageType,
    type OtaAsset,
    type OtaConfig,
    type OtaMetrics,
    type OtaPatch,
    type OtaStorageProvider,
} from './types';

const OTA_DIR = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/ota`;

// ─── Storage Provider Factory ──────────────────────────────────────────

const DEFAULT_STORAGE = new CustomStorageProvider();
const GITHUB_STORAGE = new GitHubReleaseStorageProvider();
const GITHUB_RAW_STORAGE = new GitHubRawStorageProvider();

/**
 * Get the storage provider for the given configuration.
 * Priority: explicit storage instance > storageType > default (CustomStorage)
 */
const getStorage = (config: OtaConfig): OtaStorageProvider => {
    if (config.storage) return config.storage;
    if (config.storageType === OtaStorageType.GITHUB) return GITHUB_STORAGE;
    if (config.storageType === OtaStorageType.GITHUB_RAW) return GITHUB_RAW_STORAGE;
    return DEFAULT_STORAGE;
};

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Compares two semantic version strings.
 *
 * @param a - First version string (e.g., "1.2.3")
 * @param b - Second version string (e.g., "1.2.4")
 * @returns `true` if `a >= b`, `false` otherwise
 *
 * @example
 * semverGte("1.2.3", "1.2.3") // true
 * semverGte("1.2.4", "1.2.3") // true
 * semverGte("1.2.2", "1.2.3") // false
 */
export const semverGte = (a: string, b: string): boolean => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const va = pa[i] || 0;
        const vb = pb[i] || 0;
        if (va > vb) return true;
        if (va < vb) return false;
    }
    return true; // equal
};

/**
 * Verifies the SHA-256 hash of a file.
 *
 * @param path - Absolute path to the file to verify
 * @param expectedHash - Expected SHA-256 hash (hex string). If undefined, verification is skipped.
 * @returns `true` if hash matches or `expectedHash` is undefined, `false` otherwise
 */
export const verifyHash = async (
    path: string,
    expectedHash?: string,
): Promise<boolean> => {
    if (!expectedHash) return true;
    try {
        const hash = await ReactNativeBlobUtil.fs.hash(path, 'sha256');
        return hash.toLowerCase() === expectedHash.toLowerCase();
    } catch {
        return false;
    }
};

/**
 * Verify HMAC-SHA256 signature of a file.
 *
 * Uses CryptoJS to verify that the signature matches the file content
 * using the provided HMAC key.
 *
 * @param filePath - Path to the file to verify
 * @param signature - Base64-encoded HMAC signature to verify against
 * @param publicKey - Base64-encoded HMAC key
 * @returns true if signature is valid, false otherwise
 *
 * @example
 * // Server-side (Node.js) - generate signature:
 * const crypto = require('crypto');
 * const key = crypto.randomBytes(32).toString('base64');
 * const fileBuffer = fs.readFileSync('bundle.patch');
 * const signature = crypto.createHmac('sha256', Buffer.from(key, 'base64'))
 *     .update(fileBuffer)
 *     .digest('base64');
 */
export const verifySignature = async (
    filePath: string,
    signature?: string,
    publicKey?: string,
): Promise<boolean> => {
    if (!signature || !publicKey) return true; // Skip if not configured
    try {
        // Read file content
        const fileData = await ReactNativeBlobUtil.fs.readFile(filePath, 'base64');

        // Convert base64 to WordArray for CryptoJS
        const fileWords = CryptoJS.enc.Base64.parse(fileData);
        const keyWords = CryptoJS.enc.Base64.parse(publicKey);
        const signatureWords = CryptoJS.enc.Base64.parse(signature);

        // Compute HMAC
        const hmac = CryptoJS.HmacSHA256(fileWords, keyWords);

        // Compare computed HMAC with provided signature
        const isValid = hmac.toString(CryptoJS.enc.Base64) === signatureWords.toString(CryptoJS.enc.Base64);

        if (!isValid && __DEV__) {
            console.warn('[otaCore] Signature mismatch');
        }

        return isValid;
    } catch (error) {
        if (__DEV__) {
            console.error('[otaCore] Signature verification failed:', error);
        }
        return false;
    }
};

/**
 * Decompress a .gz file in-place using native helpers.
 * Falls back to skipping decompression if no native helper is available,
 * but enforces that the patch file must NOT be gzip-compressed in that case.
 */
const decompressGzip = async (filePath: string): Promise<string> => {
    if (!filePath.endsWith('.gz')) {
        return filePath;
    }

    const decompressedPath = filePath.replace(/\.gz$/, '');
    try {
        const success = await NativeBsPatch.decompressGzip(
            filePath,
            decompressedPath,
        );
        if (success) {
            return decompressedPath;
        }
    } catch {
        // Native decompress not available — fall through
    }

    // No native gzip support: abort if file is actually compressed.
    // Do NOT silently rename a .gz file to .patch — bspatch will read gzip
    // magic bytes and fail with a confusing error.
    console.error(
        '[otaCore] .gz decompression is not supported on this platform. ' +
            'Ensure the OTA server sends uncompressed patches (compressed: false).',
    );
    throw new Error('Gzip decompression is not supported on this platform.');
};

/**
 * Download a file with retry logic using exponential backoff.
 * Cancels any in-flight request before retrying to avoid resource leaks.
 */
const downloadWithRetry = async (
    url: string,
    destPath: string,
    config: OtaConfig,
    onProgress: (percent: number) => void,
    headers: Record<string, string> = {},
): Promise<void> => {
    const retryLimit = config.network?.retry ?? 3;
    const timeout = config.network?.timeoutMs ?? 30000;

    for (let i = 0; i < retryLimit; i++) {
        let taskRef: { cancel: () => void } | null = null;
        try {
            const task = ReactNativeBlobUtil.config({
                fileCache: true,
                path: destPath,
                followRedirect: true,
                timeout,
            })
                .fetch('GET', url, {
                    'Cache-Control': 'no-cache',
                    ...headers,
                })
                .progress((received: any, total: any) => {
                    const percent = Math.floor(
                        (Number(received) / Number(total)) * 100,
                    );
                    onProgress(percent);
                });
            taskRef = { cancel: () => task.cancel() };
            await task;
            return;
        } catch (e) {
            // Cancel any lingering request before retrying
            taskRef?.cancel();
            if (i === retryLimit - 1) throw e;
            const delay = Math.pow(2, i) * 1000; // Exponential backoff: 1s, 2s, 4s...
            if (__DEV__) {
                console.warn(
                    `[otaCore] Download attempt ${
                        i + 1
                    } failed. Retrying in ${delay}ms...`,
                );
            }
            await new Promise<void>(resolve => setTimeout(resolve, delay));
        }
    }
};

// ─── Manifest ─────────────────────────────────────────────────────────

/**
 * Fetches the list of available OTA patches from the remote manifest.
 *
 * Falls back to bundled patches if the remote fetch fails, ensuring
 * the app can still apply updates that were bundled at build time.
 *
 * @param config - OTA configuration containing storage provider and fallback patches
 * @returns Array of available patches, or bundled patches if remote fetch fails
 */
export const fetchOtaManifest = async (
    config: OtaConfig,
): Promise<OtaPatch[]> => {
    try {
        const storage = getStorage(config);
        return await storage.fetchManifest(config);
    } catch (error) {
        console.warn(
            '[otaCore] Manifest fetch error:',
            (error as Error).message,
        );
        return config.bundledPatches || [];
    }
};

// ─── Hashed Asset Store ───────────────────────────────────────────────

const ASSET_STORE_DIR = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/ota/assets`;

/**
 * Downloads and syncs assets from the content-addressed asset store.
 * Only downloads assets that are not already cached locally.
 *
 * @param assetManifestUrl URL to the asset-manifest.json for this version
 * @param config OTA configuration
 * @param log Logger instance
 * @param onStatus Status update callback
 */
const downloadAndSyncAssets = async (
    assetManifestUrl: string,
    version: number,
    config: OtaConfig,
    log: ReturnType<typeof createOtaLogger>,
    onStatus: (
        status: OtaStatus,
        message: string,
        metrics?: OtaMetrics,
    ) => void,
    onProgress: (percent: number) => void,
): Promise<void> => {
    onStatus(OtaStatus.SYNCING_ASSETS, 'Syncing assets...');

    const versionDir = `${OTA_DIR}/v${version}`;
    const manifestPath = `${versionDir}/asset-manifest-v${version}.json`;

    // Ensure asset store dir exists
    if (!(await ReactNativeBlobUtil.fs.exists(ASSET_STORE_DIR))) {
        await ReactNativeBlobUtil.fs.mkdir(ASSET_STORE_DIR);
    }

    // Fetch the asset manifest
    let assets: OtaAsset[] = [];
    try {
        if (__DEV__) {
            console.log(
                `[otaCore] Fetching asset manifest from: ${assetManifestUrl}`,
            );
        }
        const resp = await ReactNativeBlobUtil.config({
            followRedirect: true,
            timeout: 10000,
        }).fetch('GET', assetManifestUrl, {
            'Cache-Control': 'no-cache',
        });

        if (resp.respInfo.status !== 200) {
            throw new Error(
                `Manifest fetch failed with status ${resp.respInfo.status}`,
            );
        }

        // Save manifest to disk for future reloads (AssetResolver needs it)
        if (!(await ReactNativeBlobUtil.fs.exists(versionDir))) {
            await ReactNativeBlobUtil.fs.mkdir(versionDir);
        }

        const manifestData =
            typeof resp.data === 'string'
                ? resp.data
                : JSON.stringify(resp.data);
        await ReactNativeBlobUtil.fs.writeFile(
            manifestPath,
            manifestData,
            'utf8',
        );
        if (__DEV__) {
            console.log(`[otaCore] Saved asset manifest to: ${manifestPath}`);
        }

        const manifest = JSON.parse(manifestData);
        // Filter out base assets, we don't need to download them
        assets = (manifest.assets || []).filter((a: any) => !a.isBase);
    } catch (e) {
        if (__DEV__) {
            console.warn('[otaCore] Failed to fetch asset manifest:', e);
        }
        return;
    }

    if (assets.length === 0) {
        if (__DEV__) {
            console.log('[otaCore] No new assets to sync for this version.');
        }
        return;
    }

    // Only notify UI now that we actually have assets to download
    onStatus(OtaStatus.SYNCING_ASSETS, `Syncing ${assets.length} asset(s)...`);

    let processed = 0;
    let downloaded = 0;
    let cached = 0;

    const updateProgress = () => {
        processed++;
        const percent = Math.round((processed / assets.length) * 100);
        onProgress(percent);
    };

    // Concurrency-limited download queue
    const maxConcurrency = 6; // Optimal for most mobile networks
    let index = 0;

    const downloadNext = async (): Promise<void> => {
        if (index >= assets.length) return;

        const asset = assets[index++];
        const filename = `${asset.hash}.${asset.ext}`;
        const localPath = `${ASSET_STORE_DIR}/${filename}`;

        // Check if already cached
        if (await ReactNativeBlobUtil.fs.exists(localPath)) {
            cached++;
            updateProgress();
            await downloadNext(); // Start next download
            return;
        }

        // Download missing asset
        onStatus(
            OtaStatus.SYNCING_ASSETS,
            `Syncing assets (${processed + 1}/${assets.length})...`,
        );
        try {
            const storage = getStorage(config);
            const assetUrl = await storage.getAssetUrl(
                asset.hash,
                asset.ext,
                config,
            );
            if (!assetUrl) {
                if (__DEV__) {
                    console.warn(
                        `[otaCore] Could not get URL for asset ${filename}`,
                    );
                }
            } else {
                await ReactNativeBlobUtil.config({
                    fileCache: true,
                    path: localPath,
                    followRedirect: true,
                    timeout: config.network?.timeoutMs ?? 30000,
                }).fetch('GET', assetUrl);
                downloaded++;
                log.emit(OtaEvent.DOWNLOAD_SUCCESS, {
                    message: `Asset downloaded: ${filename}`,
                });
            }
        } catch (e) {
            if (__DEV__) {
                console.warn(
                    `[otaCore] Failed to download asset ${filename}:`,
                    e,
                );
            }
            // Non-fatal: continue with other assets
        } finally {
            updateProgress();
            await downloadNext(); // Start next download
        }
    };

    // Start initial batch of downloads
    const initialWorkers = Math.min(maxConcurrency, assets.length);
    const workers = Array(initialWorkers)
        .fill(null)
        .map(() => downloadNext());
    await Promise.all(workers);

    onStatus(
        OtaStatus.SYNCING_ASSETS,
        `Assets synced (${downloaded} new, ${cached} cached)`,
    );
    console.log(
        `[otaCore] Assets: ${downloaded} downloaded, ${cached} from cache`,
    );
};

/**
 * Gets the local filesystem path for a content-addressed asset.
 *
 * Assets are stored by their hash, so the same asset file is shared
 * across all OTA versions that reference it.
 *
 * @param hash - SHA-256 hash of the asset content
 * @param ext - File extension (e.g., "png", "jpg")
 * @returns Absolute path to the asset in the local store
 *
 * @example
 * getLocalAssetPath("abc123...", "png")
 * // Returns: "/var/mobile/Containers/Data/Application/.../ota/assets/abc123....png"
 */
export const getLocalAssetPath = (hash: string, ext: string): string =>
    `${ASSET_STORE_DIR}/${hash}.${ext}`;

/**
 * Gets the local filesystem path for a downloaded patch file.
 *
 * @param patch - Patch metadata object
 * @param docDir - Document directory path (use `ReactNativeBlobUtil.fs.dirs.DocumentDir`)
 * @returns Absolute path to the patch file
 */
export const getLocalPatchPath = (patch: OtaPatch, docDir: string): string =>
    `${docDir}/ota/patch-${patch.id}.patch`;

// ─── Main Update Pipeline ─────────────────────────────────────────────

/**
 * Applies a single patch and reloads the bundle.
 *
 * Pipeline:
 *  1. Version compatibility check
 *  2. Download patch (with retry)
 *  3. Decompress (if .gz)
 *  4. Security signature check
 *  5. Resolve source bundle
 *  6. Verify source hash
 *  7. Apply binary patch
 *  8. Verify result hash
 *  9. Atomic commit (mv)
 * 10. Update metadata
 * 11. Reload bundle
 *
 * On failure → fallback to full bundle download if URL available.
 */
export const applyOtaPatchInternal = async (
    patch: OtaPatch,
    config: OtaConfig,
    onStatus: (
        status: OtaStatus,
        message: string,
        metrics?: OtaMetrics,
    ) => void,
    onProgress: (percent: number) => void,
) => {
    if (__DEV__ && config.allowDebugUpdates !== true) {
        onStatus(
            OtaStatus.UP_TO_DATE,
            'OTA updates are disabled while running a debug build.',
        );
        throw new Error('OTA updates are disabled while running a debug build.');
    }

    const log = createOtaLogger(config.onEvent);
    await ensureOtaDir();
    const totalStart = Date.now();

    const finalBundlePath =
        getBundlePath(patch.toVersion, config.baseAppVersion) || '';
    const tempBundle = `${finalBundlePath}.tmp`;
    const localPatchPath = getLocalPatchPath(
        patch,
        ReactNativeBlobUtil.fs.dirs.DocumentDir,
    );

    try {
        // ── Step 1: Version Compatibility ──
        if (patch.minAppVersion) {
            if (!semverGte(config.appVersion, patch.minAppVersion)) {
                log.emit(OtaEvent.VERSION_INCOMPATIBLE, {
                    message: `App ${config.appVersion} < required ${patch.minAppVersion}`,
                    version: patch.toVersion,
                });
                throw new Error(
                    `Native app ${config.appVersion} is too old. Update to ${patch.minAppVersion}+ first.`,
                );
            }
        }

        // ── Step 2: Download ──
        let downloadMs = 0;
        let patchSizeBytes = 0;
        let fromCache = false;

        if (await ReactNativeBlobUtil.fs.exists(localPatchPath)) {
            const stat = await ReactNativeBlobUtil.fs.stat(localPatchPath);
            patchSizeBytes = Number(stat.size);
            fromCache = true;
            onProgress(100);
        } else {
            log.emit(OtaEvent.DOWNLOAD_START, { version: patch.toVersion });
            onStatus(
                OtaStatus.DOWNLOADING,
                `Downloading V${patch.toVersion}...`,
            );
            const dlStart = Date.now();
            try {
                const storage = getStorage(config);
                const url = await storage.getUpdateFileUrl(
                    patch.filename,
                    config,
                );

                await downloadWithRetry(
                    url,
                    localPatchPath,
                    config,
                    onProgress,
                    {},
                );
                downloadMs = Date.now() - dlStart;
                const stat = await ReactNativeBlobUtil.fs.stat(localPatchPath);
                patchSizeBytes = Number(stat.size);
                log.emit(OtaEvent.DOWNLOAD_SUCCESS, {
                    version: patch.toVersion,
                    durationMs: downloadMs,
                    sizeKB: patchSizeBytes / 1024,
                });
            } catch (dlError) {
                log.emit(OtaEvent.DOWNLOAD_FAIL, {
                    error: (dlError as Error).message,
                    version: patch.toVersion,
                });
                throw dlError;
            }
        }

        // ── Step 3: Decompress if needed ──
        let actualPatchPath = localPatchPath;
        if (patch.compressed) {
            log.emit(OtaEvent.DECOMPRESS_START);
            onStatus(OtaStatus.APPLYING, 'Decompressing...');
            actualPatchPath = await decompressGzip(localPatchPath);
            log.emit(OtaEvent.DECOMPRESS_SUCCESS);
        }

        // ── Step 4: Signature Verification ──
        if (patch.signature && config.publicKey) {
            onStatus(OtaStatus.APPLYING, 'Verifying signature...');
            const sigValid = await verifySignature(
                actualPatchPath,
                patch.signature,
                config.publicKey,
            );
            if (!sigValid) {
                log.emit(OtaEvent.SIGNATURE_INVALID, {
                    version: patch.toVersion,
                });
                throw new Error(
                    'Patch signature verification failed. Possible MITM.',
                );
            }
        }

        // ── Step 4.2: Download & Sync Assets ──
        if (patch.assetManifestUrl) {
            const storage = getStorage(config);
            const manifestUrl = await storage.getUpdateFileUrl(
                patch.assetManifestUrl,
                config,
            );
            await downloadAndSyncAssets(
                manifestUrl,
                patch.toVersion,
                config,
                log,
                onStatus,
                onProgress,
            );
        }

        // ── Step 5: Resolve Source Bundle ──
        onStatus(OtaStatus.APPLYING, 'Preparing source...');
        const metadata = await loadMetadata(config.baseAppVersion);
        const oldBundlePath = getBundlePath(
            metadata.currentVersion,
            config.baseAppVersion,
        );

        // ── Resolve the actual old bundle path ──────────────────────────────
        // getBundlePath returns null when currentVersion == baseAppVersion, meaning
        // "use the APK's baked-in bundle". However, if BASE_APP_VERSION was bumped
        // to match a version that was applied via OTA (not actually baked into the
        // installed APK), direct APK extraction would produce a DIFFERENT file than
        // what the build script recorded as the baseHash for the next patch.
        //
        // Strategy (in order of precedence):
        //   1. Use the explicit OTA bundle path from getBundlePath (version > base) ✓
        //   2. If null (version == base), check for a previously OTA-stored bundle
        //      at ota/v{currentVersion}/ — its hash matches the server registry.
        //   3. Fall back to APK extraction only if no OTA bundle exists on disk.
        const bundleFilename =
            Platform.OS === 'android'
                ? 'index.android.bundle'
                : 'main.jsbundle';

        let actualOldPath = '';
        if (!oldBundlePath) {
            // currentVersion == baseAppVersion: prefer OTA-stored bundle for this
            // version over APK extraction (handles BASE_APP_VERSION bump scenarios).
            const otaStoredPath = `${OTA_DIR}/v${metadata.currentVersion}/${bundleFilename}`;
            if (await ReactNativeBlobUtil.fs.exists(otaStoredPath)) {
                if (__DEV__) {
                    console.log(
                        `[otaCore] Source: OTA-stored bundle for V${metadata.currentVersion} (BASE_APP_VERSION match)`,
                    );
                }
                actualOldPath = otaStoredPath;
            } else {
                // True base: extract byte-for-byte from APK assets.
                // RNFS.copyFileAssets is known to produce inconsistent bytes in some
                // APK configurations (e.g., release signing + resource shrinking).
                actualOldPath = `${OTA_DIR}/base.hbc`;
                if (!(await ReactNativeBlobUtil.fs.exists(actualOldPath))) {
                    if (__DEV__) {
                        console.log(
                            `[otaCore] Source: extracting bundle from APK assets → ${actualOldPath}`,
                        );
                    }
                    await NativeBsPatch.extractBundleFromAssets(
                        bundleFilename,
                        actualOldPath,
                    );
                } else if (__DEV__) {
                    console.log(
                        `[otaCore] Source: cached APK-extracted bundle → ${actualOldPath}`,
                    );
                }
            }
        } else {
            actualOldPath = oldBundlePath;
        }

        // ── Debug: log file sizes for diagnostic ──
        try {
            const oldStat = await ReactNativeBlobUtil.fs.stat(actualOldPath);
            const patchStat = await ReactNativeBlobUtil.fs.stat(
                actualPatchPath,
            );
            if (__DEV__) {
                console.log(
                    `[otaCore] DEBUG old bundle size=${oldStat.size} path=${actualOldPath}`,
                );
                console.log(
                    `[otaCore] DEBUG patch size=${patchStat.size} path=${actualPatchPath}`,
                );
                console.log(
                    `[otaCore] DEBUG baseHash expected=${patch.baseHash}`,
                );
            }
        } catch {
            // Non-fatal: stat is for diagnostic only
        }

        // ── Step 6: Verify Source Integrity ──
        if (patch.baseHash) {
            log.emit(OtaEvent.HASH_VERIFY_START, {
                message: 'Verifying source bundle',
            });
            onStatus(OtaStatus.APPLYING, 'Verifying source integrity...');
            const isValid = await verifyHash(actualOldPath, patch.baseHash);
            if (!isValid) {
                // Re-hash only for the diagnostic log (verifyHash doesn't return the actual hash)
                let actualSourceHash = '';
                let srcSize = 'unknown';
                try {
                    actualSourceHash = await ReactNativeBlobUtil.fs.hash(
                        actualOldPath,
                        'sha256',
                    );
                    const srcStat = await ReactNativeBlobUtil.fs.stat(
                        actualOldPath,
                    );
                    srcSize = `${srcStat.size} bytes`;
                } catch {
                    // stat failure is non-fatal for the error message
                }
                if (__DEV__) {
                    console.error(
                        '[otaCore] SOURCE HASH MISMATCH\n' +
                            `  path:     ${actualOldPath}\n` +
                            `  size:     ${srcSize}\n` +
                            `  expected: ${patch.baseHash}\n` +
                            `  actual:   ${actualSourceHash}\n` +
                            `  patch.id: ${patch.id} (v${patch.fromVersion}→v${patch.toVersion})`,
                    );
                }
                log.emit(OtaEvent.HASH_MISMATCH, {
                    version: metadata.currentVersion,
                    message: 'Source bundle hash mismatch',
                    metadata: {
                        expected: patch.baseHash,
                        actual: actualSourceHash,
                        path: actualOldPath,
                    },
                });
                throw new Error(
                    'Source bundle hash mismatch. Fallback required.',
                );
            }
            log.emit(OtaEvent.HASH_VERIFY_SUCCESS, {
                message: 'Source bundle verified',
            });
        }

        // ── Step 7: Apply Patch ──
        const versionDir = `${OTA_DIR}/v${patch.toVersion}`;
        if (!(await ReactNativeBlobUtil.fs.exists(versionDir))) {
            await ReactNativeBlobUtil.fs.mkdir(versionDir);
        }

        log.emit(OtaEvent.PATCH_START, { version: patch.toVersion });
        onStatus(OtaStatus.APPLYING, 'Applying binary patch...');
        const applyStart = Date.now();
        const success = await NativeBsPatch.applyPatch(
            actualOldPath,
            tempBundle,
            actualPatchPath,
        );
        const applyMs = Date.now() - applyStart;

        if (!success) {
            log.emit(OtaEvent.PATCH_FAIL, {
                message: 'BsPatch returned false',
                version: patch.toVersion,
            });
            throw new Error('BsPatch application failed');
        }

        // ── Step 8: Verify Result Integrity ──
        if (patch.bundleHash) {
            log.emit(OtaEvent.HASH_VERIFY_START, {
                message: 'Verifying result bundle',
            });
            onStatus(OtaStatus.APPLYING, 'Verifying integrity...');
            const isValid = await verifyHash(tempBundle, patch.bundleHash);

            if (!isValid) {
                console.error(
                    '[otaCore] Result bundle hash mismatch | expected:',
                    patch.bundleHash,
                    'path:',
                    tempBundle,
                );
                log.emit(OtaEvent.HASH_MISMATCH, {
                    message: 'Result bundle hash mismatch',
                    version: patch.toVersion,
                    metadata: {
                        expected: patch.bundleHash,
                        path: tempBundle,
                    },
                });
                throw new Error('Result bundle hash mismatch');
            }
            log.emit(OtaEvent.HASH_VERIFY_SUCCESS, {
                message: 'Result bundle verified',
            });
        }

        // ── Step 9: Atomic Commit ──
        if (await ReactNativeBlobUtil.fs.exists(finalBundlePath)) {
            await ReactNativeBlobUtil.fs.unlink(finalBundlePath);
        }
        await ReactNativeBlobUtil.fs.mv(tempBundle, finalBundlePath);

        // ── Step 10: Update Metadata ──
        const newMetadata = registerNewVersion(metadata, patch.toVersion);
        await saveMetadata(newMetadata);

        const totalMs = Date.now() - totalStart;
        log.emit(OtaEvent.PATCH_SUCCESS, {
            version: patch.toVersion,
            durationMs: totalMs,
            sizeKB: patchSizeBytes / 1024,
        });

        onStatus(OtaStatus.SUCCESS, `Update V${patch.toVersion} Successful!`, {
            patchSizeKB: patchSizeBytes / 1024,
            downloadMs,
            applyMs,
            totalMs,
            fromCache,
        });

        // ── Step 11: Reload ──
        // CRITICAL: Mark healthy BEFORE reload — reloadBundle() calls Runtime.exit(0)
        // and JS will NOT run again before restart. Native OtaBundleResolver sets
        // lastLaunchSuccessful=false before loading the new bundle. Without this call,
        // the next cold boot sees false → rollback to previous version.
        NativeBsPatch.markAsHealthy();
        if (__DEV__) {
            console.log(
                `[otaCore] V${patch.toVersion} marked healthy — reloading.`,
            );
        }
        NativeBsPatch.reloadBundle();
    } catch (error) {
        if (__DEV__) {
            console.error('[otaCore] Pipeline failed:', error);
        }

        // ── Fallback: Full Bundle Download ──
        if (patch.fullBundleUrl) {
            try {
                onStatus(
                    OtaStatus.DOWNLOADING,
                    'Fallback: Downloading full bundle...',
                );
                const storage = getStorage(config);
                const url = await storage.getUpdateFileUrl(
                    patch.fullBundleUrl || patch.filename,
                    config,
                );

                await downloadWithRetry(
                    url,
                    tempBundle,
                    config,
                    onProgress,
                    {},
                );

                // Verify full bundle hash
                if (patch.bundleHash) {
                    const isValid = await verifyHash(
                        tempBundle,
                        patch.bundleHash,
                    );
                    if (!isValid) {
                        let actualHash = '';
                        let size: number | undefined;
                        try {
                            actualHash = await ReactNativeBlobUtil.fs.hash(
                                tempBundle,
                                'sha256',
                            );
                            const stat = await ReactNativeBlobUtil.fs.stat(
                                tempBundle,
                            );
                            size = stat.size;
                        } catch {
                            // stat failure is non-fatal
                        }
                        if (__DEV__) {
                            console.error(
                                '[otaCore] Full bundle hash mismatch | expected:',
                                patch.bundleHash,
                                'actual:',
                                actualHash,
                            );
                        }
                        log.emit(OtaEvent.HASH_MISMATCH, {
                            message: 'Full bundle hash mismatch',
                            metadata: {
                                expected: patch.bundleHash,
                                actual: actualHash,
                                size,
                            },
                        });
                        throw new Error(
                            'Full bundle hash mismatch after fallback',
                        );
                    }
                }

                // Atomic swap
                if (await ReactNativeBlobUtil.fs.exists(finalBundlePath)) {
                    await ReactNativeBlobUtil.fs.unlink(finalBundlePath);
                }
                await ReactNativeBlobUtil.fs.mv(tempBundle, finalBundlePath);

                const metadata = await loadMetadata(config.baseAppVersion);
                const newMetadata = registerNewVersion(
                    metadata,
                    patch.toVersion,
                );
                await saveMetadata(newMetadata);

                // ── CRITICAL: Mark healthy BEFORE reload so native OtaBundleResolver
                // does NOT see lastLaunchSuccessful=false on the very next boot and
                // immediately rollback the version we just successfully downloaded.
                // (reloadBundle() calls Runtime.exit(0) — JS won't run again before restart)
                NativeBsPatch.markAsHealthy();
                if (__DEV__) {
                    console.log(
                        `[otaCore] Fallback V${patch.toVersion} marked healthy — reloading.`,
                    );
                }

                onStatus(
                    OtaStatus.SUCCESS,
                    `Fallback successful! Reloading...`,
                );
                NativeBsPatch.reloadBundle();
                return;
            } catch (fallbackError) {
                if (__DEV__) {
                    console.error(
                        '[otaCore] Full bundle fallback also failed:',
                        fallbackError,
                    );
                }
            }
        }

        onStatus(OtaStatus.ERROR, `Error: ${(error as Error).message}`);
        throw error;
    }
};
