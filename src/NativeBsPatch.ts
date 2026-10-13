import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type DownloadProgress = {
  /** destPath passed to downloadFile */
  path: string;
  received: number;
  /** -1 when the server sends no Content-Length */
  total: number;
};

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

  // ─── File I/O ───────────────────────────────────────────────────────

  /** Directory the native resolver reads `ota/` from (filesDir on Android, Documents on iOS) */
  getDocumentDir(): string;

  /**
   * Streams `url` to `destPath` (via `destPath.part`, renamed only on a 2xx response,
   * replacing any existing file). Rejects on network error or non-2xx status.
   * @param timeoutMs Idle timeout: no bytes for this long fails the download
   * @returns Size of the downloaded file in bytes
   */
  downloadFile(url: string, destPath: string, timeoutMs: number): Promise<number>;

  /** Lowercase hex SHA-256 of a file */
  hashFile(path: string): Promise<string>;

  exists(path: string): Promise<boolean>;
  /** Creates the directory and any missing parents */
  mkdir(path: string): Promise<void>;
  /** Deletes a file or directory tree; a missing path is not an error */
  removePath(path: string): Promise<void>;
  /** Renames a file or directory, replacing an existing destination */
  moveFile(from: string, to: string): Promise<void>;
  /** Copies a file, replacing an existing destination */
  copyFile(from: string, to: string): Promise<void>;
  /** Entry names in a directory */
  readDir(path: string): Promise<string[]>;
  /** Reads a UTF-8 file */
  readFile(path: string): Promise<string>;
  /** Writes a UTF-8 file atomically (temp file + rename) */
  writeFile(path: string, content: string): Promise<void>;

  /** Throttled (~250ms) progress for every downloadFile in flight */
  readonly onDownloadProgress: CodegenTypes.EventEmitter<DownloadProgress>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('BsPatch');
