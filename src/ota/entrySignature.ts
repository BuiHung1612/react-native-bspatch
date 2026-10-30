import type { OtaPatch } from './types';

/**
 * What `entrySignature` signs: the fields that decide which bundle a client installs.
 * Must stay byte-for-byte equal to entryPayload in tools/update_registry.js.
 */
export const entryPayload = (p: OtaPatch): string =>
    [
        'bspatch-entry-v2',
        p.appVersion,
        p.flavor ?? '',
        p.platform ?? '',
        p.fromVersion,
        p.toVersion,
        p.bundleHash ?? '',
        p.assetManifestHash ?? '',
        p.minAppVersion ?? '',
        p.runtimeFingerprint ?? '',
        p.hermesBytecodeVersion ?? '',
    ].join('\n');

/** Public keys from config or the embedded list: PEM blocks, or base64 SPKI separated by commas/whitespace */
export const parsePublicKeys = (keys: string | undefined): string[] => {
    if (!keys) return [];
    if (keys.includes('-----BEGIN')) {
        return (keys.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g) ?? []).map(block =>
            block.replace(/-----[A-Z ]+-----|\s+/g, ''),
        );
    }
    return keys.split(/[\s,]+/).filter(Boolean);
};
