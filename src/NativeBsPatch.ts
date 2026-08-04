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

  /**
   * Unzip a file to a target directory
   * @param source The absolute path to the zip file
   * @param targetDir The absolute path to the destination directory
   */
  unzip(source: string, targetDir: string): Promise<boolean>;
  extractBundleFromAssets(
    assetName: string,
    destPath: string,
  ): Promise<boolean>;

  /**
   * Decompress a gzip file to the destination path.
   * @param sourcePath Absolute path to the .gz file
   * @param destPath Absolute path to write the decompressed output
   */
  decompressGzip(sourcePath: string, destPath: string): Promise<boolean>;

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
}

export default TurboModuleRegistry.getEnforcing<Spec>('BsPatch');
