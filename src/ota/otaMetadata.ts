import { Platform } from 'react-native';
import NativeBsPatch from '../NativeBsPatch';
import { OtaMetadata } from './types';

/** Same directory the native resolver reads `ota/` from */
export const DOCUMENT_DIR = NativeBsPatch.getDocumentDir();
export const OTA_DIR = `${DOCUMENT_DIR}/ota`;
const METADATA_PATH = `${OTA_DIR}/metadata.json`;
const METADATA_TMP_PATH = `${METADATA_PATH}.tmp`;
const ASSET_STORE_DIR = `${OTA_DIR}/assets`;
/** Per-version list of `hash.ext` store files the version uses (written by otaCore) */
export const ASSET_LIST_FILE = 'assets.json';

/** Serializes metadata updates (see updateMetadata). */
let saveLock: Promise<void> = Promise.resolve();

/**
 * Ensures the OTA root directory exists.
 */
export const ensureOtaDir = (): Promise<void> => NativeBsPatch.mkdir(OTA_DIR);

/**
 * Loads the current OTA metadata from the local filesystem.
 *
 * @param defaultVersion - The version to return if no metadata exists (usually baseAppVersion).
 * @returns The persisted metadata or a default if loading fails.
 */
export const loadMetadata = async (
    defaultVersion: number,
): Promise<OtaMetadata> => {
    try {
        // Versions before 4.0 could crash between unlink and rename, leaving only the .tmp copy
        for (const path of [METADATA_PATH, METADATA_TMP_PATH]) {
            if (await NativeBsPatch.exists(path)) {
                return JSON.parse(await NativeBsPatch.readFile(path));
            }
        }
    } catch (e) {
        console.warn('[otaMetadata] Failed to load metadata:', e);
    }

    return {
        currentVersion: defaultVersion,
        previousVersions: [],
        rollbackCount: 0,
        lastLaunchSuccessful: true,
    };
};

/**
 * Atomically updates metadata: load → fn → save, serialized with every other
 * update so a background install and markHealthy can't overwrite each other.
 */
export const updateMetadata = async (
    defaultVersion: number,
    fn: (metadata: OtaMetadata) => OtaMetadata,
): Promise<OtaMetadata> => {
    const prevLock = saveLock;
    let release!: () => void;
    saveLock = new Promise<void>(resolve => (release = resolve));

    try {
        await prevLock;
        const metadata = fn(await loadMetadata(defaultVersion));
        await ensureOtaDir();
        // Native writeFile is atomic: a kill mid-write never leaves truncated JSON
        await NativeBsPatch.writeFile(METADATA_PATH, JSON.stringify(metadata, null, 2));
        return metadata;
    } catch (e) {
        console.error('[otaMetadata] Failed to save metadata:', e);
        throw new Error(`Failed to save metadata: ${(e as Error).message}`);
    } finally {
        release();
    }
};

/** Maximum number of previous versions kept in history for rollback. */
export const MAX_VERSION_HISTORY = 3;

/**
 * Rotates OTA versions for auditing and rollback capabilities.
 * Pushes the current version to the history and limits history to MAX_VERSION_HISTORY.
 *
 * @param metadata - Current metadata object.
 * @param newVersion - The newly applied OTA version.
 * @returns Updated metadata object.
 */
export const registerNewVersion = (
    metadata: OtaMetadata,
    newVersion: number,
    appVersion?: string,
): OtaMetadata => {
    const versions = [
        metadata.currentVersion,
        ...(metadata.previousVersions || []),
    ];
    // Keep internal history unique and capped
    const uniquePrevious = Array.from(new Set(versions))
        .filter(v => v !== newVersion)
        .slice(0, MAX_VERSION_HISTORY);

    return {
        ...metadata,
        appVersion: appVersion ?? metadata.appVersion,
        currentVersion: newVersion,
        previousVersions: uniquePrevious,
        rollbackCount: 0,
        lastLaunchSuccessful: true, // Native layer will set to false on next boot until JS marks healthy
    };
};

/**
 * Scans the OTA directory and removes old version directories and leftover temporary files
 * that are no longer referenced in the active metadata.
 */
export const cleanupOldVersions = async (
    metadata: OtaMetadata,
    baseVersion: number,
): Promise<void> => {
    try {
        if (!(await NativeBsPatch.exists(OTA_DIR))) return;
        const items = await NativeBsPatch.readDir(OTA_DIR);

        // Retain current active version and rollback versions
        const retainedVersions = new Set<number>([
            metadata.currentVersion,
            ...(metadata.previousVersions || []),
        ]);

        for (const item of items) {
            // Check if directory matches "v<number>"
            const versionMatch = item.match(/^v(\d+)$/);
            if (versionMatch) {
                const ver = parseInt(versionMatch[1], 10);
                // Higher than current: may be an install in progress, not yet in metadata
                if (!retainedVersions.has(ver) && ver !== baseVersion && ver < metadata.currentVersion) {
                    const dirPath = `${OTA_DIR}/${item}`;
                    await NativeBsPatch.removePath(dirPath).catch(() => {});
                    if (__DEV__) {
                        console.log(`[otaMetadata] Cleaned up obsolete OTA version: ${item}`);
                    }
                }
            }
            // Clean up leftover temporary bundle files (.tmp)
            if (item.endsWith('.tmp') && item !== 'metadata.json.tmp') {
                await NativeBsPatch.removePath(`${OTA_DIR}/${item}`).catch(() => {});
            }
        }
        await cleanupAssetStore();
    } catch (e) {
        console.warn('[otaMetadata] Cleanup old versions failed:', e);
    }
};

/**
 * Deletes store files no remaining version lists. The store is only a download
 * cache (each version holds its own copies), so this never breaks a version.
 * ponytail: an install that reuses a store file between our read of its list and
 * the unlink fails its asset sync; it is retried on the next check.
 */
const cleanupAssetStore = async (): Promise<void> => {
    const fs = NativeBsPatch;
    if (!(await fs.exists(ASSET_STORE_DIR))) return;
    const keep = new Set<string>();
    for (const item of await fs.readDir(OTA_DIR)) {
        const list = `${OTA_DIR}/${item}/${ASSET_LIST_FILE}`;
        if (/^v\d+$/.test(item) && (await fs.exists(list))) {
            const files: string[] = JSON.parse(await fs.readFile(list));
            files.forEach(f => keep.add(f));
        }
    }
    for (const file of await fs.readDir(ASSET_STORE_DIR)) {
        if (!keep.has(file)) {
            await fs.removePath(`${ASSET_STORE_DIR}/${file}`).catch(() => {});
        }
    }
};

/**
 * Marks the running version healthy: the native resolver stops treating its
 * launches as pending, so it is never rolled back afterwards (crash on first
 * launch → rollback; crash after a verified launch → app bug, not a bad bundle).
 * Also cleans up obsolete version directories from disk.
 *
 * @param defaultVersion - Base version for metadata lookup fallback.
 * @param runningVersion - Version loaded at boot. If a background install has
 *   since switched currentVersion, the new version hasn't run yet and is left pending.
 * @returns The updated metadata.
 */
export const markHealthy = async (
    defaultVersion: number,
    runningVersion: number,
    appVersion?: string,
): Promise<OtaMetadata> => {
    const updated = await updateMetadata(defaultVersion, metadata =>
        metadata.currentVersion !== runningVersion
            ? metadata
            : {
                  ...metadata,
                  // Stamp legacy metadata so the native resolver can detect a store update later
                  appVersion: metadata.appVersion ?? appVersion,
                  lastLaunchSuccessful: true,
                  rollbackCount: 0,
                  verifiedVersion: runningVersion,
              },
    );

    // Garbage collect older versions on disk to free storage
    await cleanupOldVersions(updated, defaultVersion);

    return updated;
};

/**
 * Resolves the absolute path to the JS bundle for a specific version.
 *
 * @param version - The OTA version number.
 * @param baseVersion - The app's base version (bundled).
 * @returns Absolute path to the bundle or null if it refers to the base bundle.
 */
export const getBundlePath = (
    version: number,
    baseVersion: number,
): string | null => {
    if (version === baseVersion) {
        return null;
    }
    const filename = Platform.select({
        android: 'index.android.bundle',
        ios: 'main.jsbundle',
        default: 'index.android.bundle',
    });
    return `${OTA_DIR}/v${version}/${filename}`;
};
