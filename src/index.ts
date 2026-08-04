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
export { initOtaAssetResolver, resetOtaAssetResolver } from './ota/otaAssetResolver';
export { GitHubReleaseStorageProvider } from './ota/storage/GitHubReleaseStorage';

export default {
  applyPatch,
  reloadBundle,
  markAsHealthy,
};
