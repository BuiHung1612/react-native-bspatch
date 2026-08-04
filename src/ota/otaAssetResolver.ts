import { Image, Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import NativeBsPatch from '../NativeBsPatch';

const ASSET_STORE_DIR = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/ota/assets`;

interface AssetMetadata {
    originalPath: string;
    hash: string;
    ext: string;
    isBase?: boolean;
    _normPath: string;
}

interface AssetManifest {
    assets: AssetMetadata[];
}

let assetManifest: AssetManifest | null = null;
let assetMap: Map<string, AssetMetadata> = new Map();
let assetList: AssetMetadata[] = [];
let isPatched = false;

/**
 * Internal logger with native bridge integration.
 */
const log = (msg: string): void => {
    const formatted = `[otaAssetResolver] ${msg}`;
    console.log(formatted);
    if (NativeBsPatch?.logNative) {
        NativeBsPatch.logNative(formatted);
    }
};

/**
 * Initializes the OTA asset resolver for a specific version.
 * Loads the asset manifest and prepares an O(1) lookup map for intercepted image requests.
 *
 * @param version - The OTA version number to load assets from.
 */
export const initOtaAssetResolver = async (version: number): Promise<void> => {
    const otaDir = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/ota`;
    const versionDir = `${otaDir}/v${version}`;
    const manifestPath = `${versionDir}/asset-manifest-v${version}.json`;

    try {
        if (await ReactNativeBlobUtil.fs.exists(manifestPath)) {
            const content = await ReactNativeBlobUtil.fs.readFile(
                manifestPath,
                'utf8',
            );
            assetManifest = JSON.parse(content) as AssetManifest;

            // Pre-compute normalized paths for O(1) lookup to prevent JS thread blocking during render
            const map = new Map<string, AssetMetadata>();
            const list = assetManifest.assets || [];
            list.forEach((a: AssetMetadata) => {
                const normPath = a.originalPath
                    .toLowerCase()
                    .replace(/\//g, '_')
                    .replace(/^(assets_)+/, '');
                a._normPath = normPath; // cache for fast fallback
                map.set(normPath, a);
            });
            assetMap = map;
            assetList = list;

            log(
                `Initialized version ${version} (${list.length} assets, mapped for O(1) lookup)`,
            );
            patchAssetResolver();
        } else {
            log(`Manifest NOT found at: ${manifestPath}`);
        }
    } catch (e) {
        log(`Failed to load manifest: ${(e as Error).message}`);
    }
};



/**
 * Patches React Native's Image.resolveAssetSource to intercept and redirect
 * asset requests to the locally downloaded OTA asset store.
 */
const patchAssetResolver = (): void => {
    if (isPatched) return;
    isPatched = true;

    const resolveAssetSource = (Image as unknown as {
        resolveAssetSource: {
            setCustomSourceTransformer: (
                transformer: (resolver: {
                    defaultAsset: () => { uri: string } | null;
                }) => { uri: string } | null,
            ) => void;
        };
    }).resolveAssetSource;

    if (
        resolveAssetSource &&
        typeof resolveAssetSource.setCustomSourceTransformer === 'function'
    ) {
        resolveAssetSource.setCustomSourceTransformer((resolver) => {
            // Get the default resolution result
            const res = resolver.defaultAsset();
            if (!res || !assetManifest) return res;

            const uri = res.uri;

            // Skip remote or data URIs
            // Note: We DO NOT skip 'file://' because local bundles use it for relative asset resolution.
            if (!uri || uri.startsWith('http') || uri.startsWith('data')) {
                return res;
            }

            const normUri = uri
                .toLowerCase()
                .replace(/\//g, '_')
                .replace(/^(assets_)+/, '');

            // 1. Fast O(1) Map lookup
            let found = assetMap.get(normUri);

            // 2. Fallback O(N) fuzzy matching (without regex overhead)
            if (!found) {
                found = assetList.find((a: AssetMetadata) => {
                    return (
                        a._normPath.endsWith(normUri) ||
                        normUri.endsWith(a._normPath)
                    );
                });
            }

            if (found) {
                if (found.isBase) {
                    if (Platform.OS === 'ios') {
                        // iOS: OTA bundle generates wrong relative paths for base assets, redirect to MainBundleDir
                        const finalUri = `file://${ReactNativeBlobUtil.fs.dirs.MainBundleDir}/${found.originalPath}`;
                        log(`REDIRECTED (BASE): ${uri} -> (MainBundle: ${finalUri})`);
                        return { ...res, uri: finalUri };
                    } else {
                        // Android: let the default responder load it from apk assets (res.uri is correct)
                        return res;
                    }
                }

                const localPath = `${ASSET_STORE_DIR}/${found.hash}.${found.ext}`;
                // iOS & Android: requires file:// prefix for absolute filesystem paths
                const finalUri = `file://${localPath}`;
                log(`REDIRECTED: ${uri} -> ${found.hash} (Local: ${finalUri})`);
                return { ...res, uri: finalUri };
            }

            // Diagnostic logging for missed assets that appear to be internal resources
            if (uri.includes('assets')) {
                log(`MISS: ${uri} (Not found in manifest)`);
            }

            return res;
        });
        log('Successfully attached CustomSourceTransformer.');
    } else {
        log(
            'ERROR: setCustomSourceTransformer is not available in this React Native version.',
        );
    }
};

/**
 * Resets the OTA asset resolver state.
 * Call this before a major app upgrade or when unmounting the OTA context.
 * Clears cached manifest data and resets the transformer patch guard so
 * `initOtaAssetResolver` can re-patch cleanly on next call.
 */
export const resetOtaAssetResolver = (): void => {
    assetManifest = null;
    assetMap = new Map();
    assetList = [];
    isPatched = false;
};

