import type { OtaPatch } from './types';

/** Entry `requires` values this client understands */
export const SUPPORTED_FEATURES = ['gzip', 'bz2'];

export type EligibilityContext = {
    /** Platform.OS */
    platform: string;
    /** Versions that crashed on boot here and were rolled back */
    failedVersions: number[];
    /** Fingerprint stamped into this binary ('' when the build hook didn't run) */
    runtimeFingerprint: string;
    /** Bytecode version of the running Hermes (undefined off Hermes) */
    hermesBytecodeVersion?: number;
    installId: string;
};

/** FNV-1a: stable 0-99 bucket for an install and version (a different slice of installs per version) */
export const rolloutBucket = (installId: string, version: number): number => {
    let h = 0x811c9dc5;
    for (const c of `${installId}:${version}`) {
        h ^= c.charCodeAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % 100;
};

/** Why this client must not install the entry, or null when it may */
export const ineligibleReason = (e: OtaPatch, ctx: EligibilityContext): string | null => {
    if (e.platform && e.platform.toLowerCase() !== ctx.platform) return 'other platform';
    if (ctx.failedVersions.includes(e.toVersion)) return 'crashed on boot here before';
    if (e.disabled) return 'disabled';
    const missing = (e.requires ?? []).filter(f => !SUPPORTED_FEATURES.includes(f));
    if (missing.length) return `needs a newer client (${missing.join(', ')})`;
    if (e.runtimeFingerprint && e.runtimeFingerprint !== ctx.runtimeFingerprint) {
        return ctx.runtimeFingerprint
            ? 'built for different native code (needs a store build)'
            : 'this binary has no runtime fingerprint (run `react-native-bspatch setup` and rebuild)';
    }
    if (e.hermesBytecodeVersion && ctx.hermesBytecodeVersion && e.hermesBytecodeVersion !== ctx.hermesBytecodeVersion) {
        return `Hermes bytecode ${e.hermesBytecodeVersion}, runtime reads ${ctx.hermesBytecodeVersion}`;
    }
    if (e.allowInstallIds?.length && !e.allowInstallIds.includes(ctx.installId)) return 'not in the QA list';
    if (e.rolloutPercent !== undefined && rolloutBucket(ctx.installId, e.toVersion) >= e.rolloutPercent) {
        return `outside the ${e.rolloutPercent}% rollout`;
    }
    return null;
};
