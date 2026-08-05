import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { OtaMetadata } from './types';

const OTA_DIR = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/ota`;
const METADATA_PATH = `${OTA_DIR}/metadata.json`;

/** Promise-based lock to prevent concurrent metadata writes (double-tap guard). */
let saveLock: Promise<void> = Promise.resolve();

/**
 * Ensures the OTA root directory exists.
 */
export const ensureOtaDir = async (): Promise<void> => {
    if (!(await ReactNativeBlobUtil.fs.exists(OTA_DIR))) {
        await ReactNativeBlobUtil.fs.mkdir(OTA_DIR);
    }
};

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
        if (await ReactNativeBlobUtil.fs.exists(METADATA_PATH)) {
            const content = await ReactNativeBlobUtil.fs.readFile(
                METADATA_PATH,
                'utf8',
            );
            return JSON.parse(content);
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
 * Persists OTA metadata to the local filesystem.
 *
 * @param metadata - The metadata object to save.
 */
export const saveMetadata = async (metadata: OtaMetadata): Promise<void> => {
    // Wait for any in-flight save to complete before starting our own
    const prevLock = saveLock;
    let settleFn: (() => void) | undefined;
    saveLock = new Promise<void>(resolve => { settleFn = resolve; });

    try {
        await prevLock;
        await ensureOtaDir();
        await ReactNativeBlobUtil.fs.writeFile(
            METADATA_PATH,
            JSON.stringify(metadata, null, 2),
            'utf8',
        );
    } catch (e) {
        console.error('[otaMetadata] Failed to save metadata:', e);
        throw new Error(`Failed to save metadata: ${(e as Error).message}`);
    } finally {
        settleFn!();
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
        currentVersion: newVersion,
        previousVersions: uniquePrevious,
        rollbackCount: 0,
        lastLaunchSuccessful: true, // Native layer will set to false on next boot until JS marks healthy
    };
};

/**
 * Marks the current session as healthy, indicating a successful boot.
 * This prevents the native bridge from rolling back the version on the next launch.
 *
 * @param defaultVersion - Base version for metadata lookup fallback.
 * @returns The updated metadata.
 */
export const markHealthy = async (
    defaultVersion: number,
): Promise<OtaMetadata> => {
    const metadata = await loadMetadata(defaultVersion);
    if (metadata.lastLaunchSuccessful && metadata.rollbackCount === 0) {
        return metadata;
    }

    const updated: OtaMetadata = {
        ...metadata,
        lastLaunchSuccessful: true,
        rollbackCount: 0,
    };
    await saveMetadata(updated);
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
