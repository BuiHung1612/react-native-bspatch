import NativeBsPatch from './src/NativeBsPatch';

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

/**
 * OTA Components
 */
export * from './src/ota/otaLogger';
export * from './src/ota/OtaProvider';
export * from './src/ota/types';
export { initOtaAssetResolver, resetOtaAssetResolver } from './src/ota/otaAssetResolver';
export { GitHubReleaseStorageProvider } from './src/ota/storage/GitHubReleaseStorage';
export { GitHubRawStorageProvider } from './src/ota/storage/GitHubRawStorage';

export default {
  applyPatch,
  reloadBundle,
  markAsHealthy,
};
