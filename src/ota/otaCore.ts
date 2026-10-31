/**
 * Core OTA Logic (Stateless)
 *
 * Responsibilities:
 *  - Download patches with retry
 *  - Verify integrity (SHA-256 hash)
 *  - Verify security (RSA/ECDSA signature)
 *  - Apply binary patch (bsdiff) from the installed OTA bundle
 *  - Full bundle download (first OTA after a store install, or patch failure)
 *  - Atomic bundle swap
 *  - Structured telemetry logging
 */

import { Platform } from 'react-native';
import NativeBsPatch from '../NativeBsPatch';
import { entryPayload, parsePublicKeys } from './entrySignature';
import { createOtaLogger, OtaEvent } from './otaLogger';
import {
    ASSET_LIST_FILE,
    DOCUMENT_DIR,
    ensureOtaDir,
    OTA_DIR,
    getBundlePath,
    loadMetadata,
    registerNewVersion,
    updateMetadata,
} from './otaMetadata';
import { normalizeChannel, R2StorageProvider } from './storage/R2Storage';
import {
    OtaStatus,
    type OtaAsset,
    type OtaConfig,
    type OtaMetrics,
    type OtaPatch,
    type OtaStorageProvider,
} from './types';

// ─── Storage Provider Factory ──────────────────────────────────────────

const DEFAULT_STORAGE = new R2StorageProvider();

/** Explicit `config.storage` or the default provider (R2 public URL). */
const getStorage = (config: OtaConfig): OtaStorageProvider =>
    config.storage ?? DEFAULT_STORAGE;

/**
 * Returns a message for config the default provider can't work with, else null.
 * No fallbacks: a missing env value must surface, not silently point somewhere else.
 */
export const validateOtaConfig = (config: OtaConfig): string | null => {
    if (config.storage) return null;
    const { baseUrl, channel } = config.customServer ?? {};
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
        return `customServer.baseUrl must be an http(s) URL, got ${JSON.stringify(baseUrl)}`;
    }
    if (!channel) {
        return `customServer.channel is required, got ${JSON.stringify(channel)}`;
    }
    return null;
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
        const hash = await NativeBsPatch.hashFile(path);
        return hash.toLowerCase() === expectedHash.toLowerCase();
    } catch {
        return false;
    }
};

/**
 * When there is a public key (config.publicKey, else the embedded ones), an RSA/ECDSA
 * SHA-256 signature is mandatory and must verify against one of them (fail closed):
 * the backup key takes over without a store build if the primary is lost.
 */
const assertSigned = async (
    filePath: string,
    signature: string | undefined,
    config: OtaConfig,
    what: string,
): Promise<void> => {
    const keys = parsePublicKeys(config.publicKey);
    if (keys.length === 0) return;
    let valid = false;
    for (const key of signature ? keys : []) {
        if (await NativeBsPatch.verifySignature(filePath, signature!, key).catch(() => false)) {
            valid = true;
            break;
        }
    }
    if (!valid) {
        throw new Error(`${what} signature missing or invalid`);
    }
};

/**
 * With config.publicKey the registry entry itself must be signed and meant for this app,
 * so a registry served by someone else (e.g. a lapsed domain) can't hand over another
 * flavor's, platform's or release's signed bundle, or swap the asset manifest.
 */
const assertEntrySigned = async (patch: OtaPatch, config: OtaConfig): Promise<void> => {
    if (parsePublicKeys(config.publicKey).length === 0) return;
    const channel = config.customServer?.channel;
    const mismatch =
        patch.appVersion !== config.appVersion
            ? 'appVersion'
            : patch.platform !== Platform.OS
                ? 'platform'
                : channel && patch.flavor !== normalizeChannel(channel)
                    ? 'flavor'
                    : patch.assetManifestUrl && !patch.assetManifestHash
                        ? 'assetManifestHash'
                        : null;
    if (mismatch) {
        throw new Error(`Registry entry rejected: ${mismatch} doesn't match this app`);
    }
    const payloadPath = `${OTA_DIR}/entry-payload.txt`;
    await NativeBsPatch.writeFile(payloadPath, entryPayload(patch));
    try {
        await assertSigned(payloadPath, patch.entrySignature, config, 'Registry entry');
    } finally {
        await NativeBsPatch.removePath(payloadPath).catch(() => {});
    }
};

/**
 * Download a file with retry logic using exponential backoff.
 * Native streams to `${destPath}.part` and renames only on a 2xx response, so a
 * cut-off download or an error page never sits at destPath looking complete;
 * each retry resumes where the last attempt stopped.
 * @returns Size of the downloaded file in bytes
 */
const downloadWithRetry = async (
    url: string,
    destPath: string,
    config: OtaConfig,
    onProgress: (percent: number) => void,
): Promise<number> => {
    const retryLimit = Math.max(1, config.network?.retry ?? 3);
    const timeout = config.network?.timeoutMs ?? 30000;
    const headers = JSON.stringify(config.customServer?.headers ?? {});
    const subscription = NativeBsPatch.onDownloadProgress(e => {
        // total is -1 without a Content-Length
        if (e.path === destPath && e.total > 0) {
            onProgress(Math.min(100, Math.floor((e.received / e.total) * 100)));
        }
    });

    try {
        for (let i = 0; ; i++) {
            try {
                return await NativeBsPatch.downloadFile(url, destPath, timeout, headers);
            } catch (e) {
                if (i >= retryLimit - 1) throw e;
                const delay = Math.pow(2, i) * 1000; // Exponential backoff: 1s, 2s, 4s...
                if (__DEV__) {
                    console.warn(`[otaCore] Download attempt ${i + 1} failed. Retrying in ${delay}ms...`);
                }
                await new Promise<void>(resolve => setTimeout(resolve, delay));
            }
        }
    } finally {
        subscription.remove();
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
 * @returns Patches for this app version + channel; rejects if the registry can't be read
 */
export const fetchOtaManifest = (config: OtaConfig): Promise<OtaPatch[]> =>
    getStorage(config).fetchManifest(config);

// ─── Hashed Asset Store ───────────────────────────────────────────────

const ASSET_STORE_DIR = `${OTA_DIR}/assets`;

/**
 * Relative path inside the version dir: no absolute paths, `..` segments, backslashes or
 * control characters. Anything else (spaces, `@1,5x`, non-ASCII names) is a valid asset path.
 */
const isSafeRelativePath = (p: string): boolean =>
    p.length > 0 &&
    !/[\\\x00-\x1f\x7f]/.test(p) &&
    !p.startsWith('/') &&
    !p.split('/').includes('..');

/**
 * Downloads this version's assets and places each one next to the bundle, at the
 * path React Native resolves by default for a bundle loaded from a file:
 *   Android: ota/vN/drawable-xxhdpi/foo.png, ota/vN/raw/bar.glb
 *   iOS:     ota/vN/assets/src/images/foo@2x.png
 * So images resolve correctly from the very first render, with no JS source
 * transformer (which raced the first render). Files are fetched once per content
 * hash into ota/assets/ and copied from there for later versions.
 */
const downloadAndSyncAssets = async (
    assetManifestUrl: string,
    assetManifestHash: string | undefined,
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
    const fs = NativeBsPatch;
    onStatus(OtaStatus.SYNCING_ASSETS, 'Syncing assets...');
    const versionDir = `${OTA_DIR}/v${version}`;

    let assets: OtaAsset[] = [];
    try {
        // Through a file: its hash is in the (signed) registry entry
        const manifestPath = `${versionDir}/asset-manifest.json`;
        await downloadWithRetry(assetManifestUrl, manifestPath, config, () => {});
        if (!(await verifyHash(manifestPath, assetManifestHash))) {
            throw new Error('hash mismatch');
        }
        const manifest = JSON.parse(await fs.readFile(manifestPath));
        await fs.removePath(manifestPath).catch(() => {});
        assets = manifest.assets || [];
        // Hash/ext/path become file names: reject anything unexpected. Fatal, not
        // skipped: the bundle would go live with that image missing
        const bad = assets.find(
            (a: any) =>
                !/^[a-f0-9]{64}$/i.test(a.hash) ||
                !/^[a-z0-9]+$/i.test(a.ext) ||
                typeof a.originalPath !== 'string' ||
                !isSafeRelativePath(a.originalPath),
        );
        if (bad) {
            throw new Error(`invalid entry ${JSON.stringify(bad)}`);
        }
    } catch (e) {
        // Fatal: activating the bundle without its assets leaves images blank
        throw new Error(`Failed to fetch asset manifest: ${(e as Error).message}`);
    }
    if (assets.length === 0) return;
    // Lets cleanupOldVersions keep the store files that retained versions use
    await fs.writeFile(
        `${versionDir}/${ASSET_LIST_FILE}`,
        JSON.stringify(assets.map(a => `${a.hash}.${a.ext}`)),
    );

    onStatus(OtaStatus.SYNCING_ASSETS, `Syncing ${assets.length} asset(s)...`);
    // Native mkdir creates parents and tolerates an existing dir; this just skips repeats
    const dirs = new Map<string, Promise<void>>();
    const ensureDir = (dir: string): Promise<void> => {
        if (!dirs.has(dir)) {
            dirs.set(dir, fs.mkdir(dir));
        }
        return dirs.get(dir)!;
    };
    await ensureDir(ASSET_STORE_DIR);

    let processed = 0;
    let downloaded = 0;
    let failed = 0;
    let index = 0;
    // Same content at two paths: one download per store file, never two writers on its .part
    const fetches = new Map<string, Promise<void>>();
    const fetchToStore = async (asset: OtaAsset, storePath: string): Promise<void> => {
        if (await fs.exists(storePath)) return;
        const url = await getStorage(config).getAssetUrl(asset.hash, asset.ext, config);
        if (!url) throw new Error('no URL');
        await downloadWithRetry(url, storePath, config, () => {});
        if (!(await verifyHash(storePath, asset.hash))) {
            await fs.removePath(storePath).catch(() => {});
            throw new Error('hash mismatch');
        }
        downloaded++;
    };

    const worker = async (): Promise<void> => {
        while (index < assets.length) {
            const asset = assets[index++];
            const storePath = getLocalAssetPath(asset.hash, asset.ext);
            try {
                if (!fetches.has(storePath)) {
                    fetches.set(storePath, fetchToStore(asset, storePath));
                }
                await fetches.get(storePath);
                const dest = `${versionDir}/${asset.originalPath}`;
                await ensureDir(dest.slice(0, dest.lastIndexOf('/')));
                await fs.copyFile(storePath, dest);
            } catch (e) {
                if (__DEV__) {
                    console.warn(`[otaCore] Asset ${asset.originalPath} failed:`, e);
                }
                failed++; // keep going, fail the sync at the end
            }
            processed++;
            onProgress(Math.round((processed / assets.length) * 100));
        }
    };

    // Concurrency-limited queue: 6 parallel requests suit most mobile networks
    await Promise.all(Array.from({ length: Math.min(6, assets.length) }, worker));

    if (failed > 0) {
        throw new Error(`${failed} asset(s) failed to download`);
    }
    log.emit(OtaEvent.DOWNLOAD_SUCCESS, {
        version,
        message: `Assets: ${assets.length} placed, ${downloaded} downloaded`,
    });
    onStatus(OtaStatus.SYNCING_ASSETS, `Assets synced (${downloaded} new)`);
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
 * @param docDir - Document directory path (`DOCUMENT_DIR`)
 * @returns Absolute path to the patch file
 */
export const getLocalPatchPath = (patch: OtaPatch, docDir: string): string =>
    `${docDir}/ota/patch-${patch.appVersion}-${patch.id}.patch`;

/**
 * Picks the registry entry for `localV → targetV`: a patch from the OTA bundle
 * already on disk, else the full-bundle entry (store build, or outside the patch window).
 * `patchList` is already filtered to this platform (checkUpdates).
 */
export const selectUpdate = (
    patchList: OtaPatch[],
    localV: number,
    targetV: number,
): OtaPatch | undefined => {
    const forTarget = patchList.filter(p => p.toVersion === targetV);
    return (
        forTarget.find(p => p.filename && p.fromVersion === localV) ??
        forTarget.find(p => !p.filename)
    );
};

// ─── Main Update Pipeline ─────────────────────────────────────────────

/**
 * Installs one OTA version.
 *
 * Patch path (an OTA bundle for `patch.fromVersion` is on disk):
 *   download patch → signature → source hash → bspatch → result hash/signature
 * Full path (store build, no patch, or patch path failed):
 *   download full bundle → hash → signature
 * Both then: sync assets → atomic commit → metadata → mark healthy → reload.
 * Only a patch-path failure falls back to the full bundle, never a failed commit.
 *
 * The store build's bundle is never used as a patch source: it can't be
 * reproduced byte-for-byte at build time, so the first OTA is always a full download.
 */
let updateInFlight = false;

/** Runs the pipeline below; rejects if another update is already running. */
export const applyOtaPatchInternal: typeof runUpdatePipeline = async (...args) => {
    if (updateInFlight) {
        throw new Error('Another OTA update is already in progress');
    }
    updateInFlight = true;
    try {
        return await runUpdatePipeline(...args);
    } finally {
        updateInFlight = false;
    }
};

const runUpdatePipeline = async (
    patch: OtaPatch,
    config: OtaConfig,
    onStatus: (
        status: OtaStatus,
        message: string,
        metrics?: OtaMetrics,
    ) => void,
    onProgress: (percent: number) => void,
    options: { autoReload?: boolean } = { autoReload: true },
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
    try {
        await assertEntrySigned(patch, config);
    } catch (error) {
        log.emit(OtaEvent.SIGNATURE_INVALID, { version: patch.toVersion, error: (error as Error).message });
        onStatus(OtaStatus.ERROR, `Error: ${(error as Error).message}`);
        throw error;
    }
    const totalStart = Date.now();
    const fs = NativeBsPatch;

    const finalBundlePath =
        getBundlePath(patch.toVersion, config.baseAppVersion) || '';
    const tempBundle = `${finalBundlePath}.tmp`;
    /** Compressed full bundle, before decompressing into tempBundle */
    const tempDownload = `${finalBundlePath}.download`;
    const versionDir = `${OTA_DIR}/v${patch.toVersion}`;
    const localPatchPath = getLocalPatchPath(patch, DOCUMENT_DIR);

    // ── Version Compatibility ──
    // Checked before anything else so an incompatible update can't reach the full-bundle path
    if (patch.minAppVersion) {
        let currentAppVer = config.appVersion;
        if (!currentAppVer) {
            currentAppVer = await NativeBsPatch.getAppVersion().catch(() => undefined);
        }
        if (!currentAppVer) {
            throw new Error(
                '[otaCore] Cannot verify minAppVersion: Native App Version could not be determined.',
            );
        }
        if (!semverGte(currentAppVer, patch.minAppVersion)) {
            log.emit(OtaEvent.VERSION_INCOMPATIBLE, {
                message: `App ${currentAppVer} < required ${patch.minAppVersion}`,
                version: patch.toVersion,
            });
            throw new Error(
                `Native app ${currentAppVer} is too old. Update to ${patch.minAppVersion}+ first.`,
            );
        }
    }

    // Room for the download, the decompressed bundle and its assets; a full disk mid-write
    // would fail later and leave the user's storage fuller
    const needBytes = (patch.bundleSize ?? 0) * 3 + 20 * 1024 * 1024;
    const freeBytes = await fs.getFreeDiskSpace().catch(() => Number.MAX_SAFE_INTEGER);
    if (freeBytes < needBytes) {
        throw new Error(`Not enough free storage: ${Math.ceil(needBytes / 1048576)} MB needed`);
    }

    await fs.mkdir(versionDir);

    const download = async (remoteName: string, dest: string) => {
        log.emit(OtaEvent.DOWNLOAD_START, { version: patch.toVersion });
        const dlStart = Date.now();
        let sizeBytes: number;
        try {
            const url = await getStorage(config).getUpdateFileUrl(remoteName, config);
            sizeBytes = await downloadWithRetry(url, dest, config, onProgress);
        } catch (dlError) {
            log.emit(OtaEvent.DOWNLOAD_FAIL, {
                error: (dlError as Error).message,
                version: patch.toVersion,
            });
            throw dlError;
        }
        const downloadMs = Date.now() - dlStart;
        log.emit(OtaEvent.DOWNLOAD_SUCCESS, {
            version: patch.toVersion,
            durationMs: downloadMs,
            sizeKB: sizeBytes / 1024,
        });
        return { downloadMs, sizeBytes };
    };

    const assertHash = async (path: string, expected: string | undefined, what: string) => {
        if (!expected || (await verifyHash(path, expected))) return;
        const actual = await fs.hashFile(path).catch(() => '');
        log.emit(OtaEvent.HASH_MISMATCH, {
            message: `${what} hash mismatch`,
            version: patch.toVersion,
            metadata: { expected, actual, path },
        });
        throw new Error(`${what} hash mismatch`);
    };

    type BundleMetrics = Omit<OtaMetrics, 'totalMs' | 'fromCache'>;

    /** tempBundle is verified: sync assets, swap it in, record the version, reload. */
    const commit = async (metrics: BundleMetrics) => {
        if (patch.assetManifestUrl) {
            const manifestUrl = await getStorage(config).getUpdateFileUrl(
                patch.assetManifestUrl,
                config,
            );
            await downloadAndSyncAssets(
                manifestUrl,
                patch.assetManifestHash,
                patch.toVersion,
                config,
                log,
                onStatus,
                onProgress,
            );
        }

        await fs.moveFile(tempBundle, finalBundlePath);

        // Native version, not config.appVersion: the native resolver compares against it on boot
        const nativeAppVersion = await NativeBsPatch.getAppVersion().catch(() => config.appVersion);
        await updateMetadata(config.baseAppVersion, metadata =>
            registerNewVersion(metadata, patch.toVersion, nativeAppVersion),
        );

        const totalMs = Date.now() - totalStart;
        log.emit(OtaEvent.PATCH_SUCCESS, {
            version: patch.toVersion,
            durationMs: totalMs,
            sizeKB: metrics.patchSizeKB,
        });
        onStatus(OtaStatus.SUCCESS, `Update V${patch.toVersion} Successful!`, {
            ...metrics,
            totalMs,
            fromCache: false,
        });

        // registerNewVersion left lastLaunchSuccessful=true: the native resolver marks the
        // first launch of the new version pending, and JS marks it healthy once it renders.
        if (options.autoReload !== false) {
            NativeBsPatch.reloadBundle();
        } else if (__DEV__) {
            console.log(
                `[otaCore] V${patch.toVersion} prepared in background — applies on next launch.`,
            );
        }
    };

    /** Leaves the verified result at tempBundle. */
    const applyPatchFile = async (sourcePath: string): Promise<BundleMetrics> => {
        onStatus(OtaStatus.DOWNLOADING, `Downloading V${patch.toVersion}...`);
        const { downloadMs, sizeBytes } = await download(patch.filename!, localPatchPath);

        // Verify before feeding the patch to native bspatch
        onStatus(OtaStatus.APPLYING, 'Verifying...');
        try {
            await assertSigned(localPatchPath, patch.signature, config, 'Patch');
        } catch (sigError) {
            log.emit(OtaEvent.SIGNATURE_INVALID, { version: patch.toVersion });
            throw sigError;
        }
        await assertHash(sourcePath, patch.baseHash, 'Source bundle');

        log.emit(OtaEvent.PATCH_START, { version: patch.toVersion });
        onStatus(OtaStatus.APPLYING, 'Applying binary patch...');
        const applyStart = Date.now();
        const success = await NativeBsPatch.applyPatch(sourcePath, tempBundle, localPatchPath);
        const applyMs = Date.now() - applyStart;
        await fs.removePath(localPatchPath).catch(() => {});
        if (!success) {
            log.emit(OtaEvent.PATCH_FAIL, {
                message: 'BsPatch returned false',
                version: patch.toVersion,
            });
            throw new Error('BsPatch application failed');
        }

        await assertHash(tempBundle, patch.bundleHash, 'Result bundle');
        await assertSigned(tempBundle, patch.bundleSignature, config, 'Bundle');
        return { patchSizeKB: sizeBytes / 1024, downloadMs, applyMs };
    };

    /** Leaves the verified full bundle at tempBundle. */
    const installFullBundle = async (): Promise<BundleMetrics> => {
        if (!patch.fullBundleUrl) {
            throw new Error(`No full bundle for V${patch.toVersion}`);
        }
        log.emit(OtaEvent.FALLBACK_FULL_BUNDLE, { version: patch.toVersion });
        onStatus(OtaStatus.DOWNLOADING, `Downloading V${patch.toVersion} (full bundle)...`);
        const compression = patch.fullBundleCompression;
        const { downloadMs, sizeBytes } = await download(patch.fullBundleUrl, compression ? tempDownload : tempBundle);
        if (compression) {
            onStatus(OtaStatus.APPLYING, 'Decompressing...');
            await fs.decompressFile(tempDownload, tempBundle, compression);
            await fs.removePath(tempDownload).catch(() => {});
        }
        await assertHash(tempBundle, patch.bundleHash, 'Full bundle');
        await assertSigned(tempBundle, patch.bundleSignature, config, 'Full bundle');
        return { patchSizeKB: sizeBytes / 1024, downloadMs, applyMs: 0 };
    };

    const cleanup = async () => {
        await fs.removePath(localPatchPath).catch(() => {});
        await fs.removePath(tempBundle).catch(() => {});
        // tempDownload's .part stays: the next attempt resumes it
        await fs.removePath(tempDownload).catch(() => {});
    };

    // Patch only from an OTA bundle we installed ourselves (byte-identical to the build output)
    const metadata = await loadMetadata(config.baseAppVersion);
    const sourcePath = getBundlePath(metadata.currentVersion, config.baseAppVersion);
    const canPatch =
        !!patch.filename &&
        patch.fromVersion === metadata.currentVersion &&
        !!sourcePath &&
        (await fs.exists(sourcePath));

    // Only a failed patch falls back to the full bundle; a failed commit (asset sync)
    // would fail the same way after re-downloading the whole bundle
    let metrics: BundleMetrics | undefined;
    if (canPatch) {
        try {
            metrics = await applyPatchFile(sourcePath!);
        } catch (error) {
            await cleanup();
            if (__DEV__) {
                console.warn('[otaCore] Patch failed, falling back to full bundle:', error);
            }
            if (!patch.fullBundleUrl) {
                onStatus(OtaStatus.ERROR, `Error: ${(error as Error).message}`);
                throw error;
            }
        }
    }

    try {
        await commit(metrics ?? (await installFullBundle()));
    } catch (error) {
        await cleanup();
        onStatus(OtaStatus.ERROR, `Error: ${(error as Error).message}`);
        throw error;
    }
};
