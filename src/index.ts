import NativeBsPatch from './NativeBsPatch';

export function applyPatch(
  oldBundlePath: string,
  newBundlePath: string,
  patchPath: string,
): Promise<boolean> {
  return NativeBsPatch.applyPatch(oldBundlePath, newBundlePath, patchPath);
}

export function markAsHealthy(): void {
  return NativeBsPatch.markAsHealthy();
}

export function reloadBundle(): void {
  return NativeBsPatch.reloadBundle();
}

export * from './ota/otaLogger';
export * from './ota/OtaProvider';
export * from './ota/types';

/**
 * @deprecated No-ops since 3.1: OTA assets are placed next to the bundle, where React
 * Native resolves them by default, so no source transformer is needed.
 */
export const initOtaAssetResolver = async (_version: number): Promise<void> => {};
/** @deprecated No-op since 3.1, see initOtaAssetResolver. */
export const resetOtaAssetResolver = (): void => {};
export { GitHubRawStorageProvider } from './ota/storage/GitHubRawStorage';

export default {
  applyPatch,
  reloadBundle,
  markAsHealthy,
};
