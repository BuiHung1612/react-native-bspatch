import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Apply a bspatch file to an old bundle to generate a new bundle
   * @param oldPath The absolute path to the existing bundle file
   * @param newPath The absolute path where the new bundle should be saved
   * @param patchPath The absolute path to the patch file
   * @param callback Promise-like callback receiving true if successful, or false on error.
   */
  applyPatch(
    oldPath: string,
    newPath: string,
    patchPath: string,
  ): Promise<boolean>;

  extractBundleFromAssets(
    assetName: string,
    destPath: string,
  ): Promise<boolean>;

  /**
   * Mark the current boot as healthy to prevent rollback
   */
  markAsHealthy(): void;

  /**
   * Reload the React Native JS bundle
   */
  reloadBundle(): void;

  /**
   * Log a message to the native console (NSLog on iOS)
   */
  logNative(message: string): void;

  /**
   * Verify an RSA/ECDSA SHA-256 signature natively with streaming file I/O
   * @param filePath Absolute path to the file to verify
   * @param signature Base64-encoded signature
   * @param publicKey SPKI public key (PEM or base64)
   */
  verifySignature(
    filePath: string,
    signature: string,
    publicKey: string,
  ): Promise<boolean>;

  /**
   * Returns the native app version (versionName on Android, CFBundleShortVersionString on iOS)
   */
  getAppVersion(): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('BsPatch');
