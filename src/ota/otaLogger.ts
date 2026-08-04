/**
 * OTA Structured Event Logger
 *
 * Provides a centralized logging system for all OTA operations.
 * Events can be forwarded to external analytics via the `onEvent` callback in OtaConfig.
 */

import NativeBsPatch from '../NativeBsPatch';

export enum OtaEvent {
  CHECK_UPDATE = 'check_update',
  DOWNLOAD_START = 'download_start',
  DOWNLOAD_SUCCESS = 'download_success',
  DOWNLOAD_FAIL = 'download_fail',
  PATCH_START = 'patch_start',
  PATCH_SUCCESS = 'patch_success',
  PATCH_FAIL = 'patch_fail',
  HASH_VERIFY_START = 'hash_verify_start',
  HASH_VERIFY_SUCCESS = 'hash_verify_success',
  HASH_MISMATCH = 'hash_mismatch',
  ROLLBACK = 'rollback',
  FALLBACK_FULL_BUNDLE = 'fallback_full_bundle',
  MARK_HEALTHY = 'mark_healthy',
  RESET_FACTORY = 'reset_factory',
  VERSION_INCOMPATIBLE = 'version_incompatible',
  SIGNATURE_INVALID = 'signature_invalid',
  DECOMPRESS_START = 'decompress_start',
  DECOMPRESS_SUCCESS = 'decompress_success',
}

export type OtaLogEntry = {
  event: OtaEvent;
  timestamp: number;
  version?: number;
  message?: string;
  durationMs?: number;
  sizeKB?: number;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type OtaEventCallback = (entry: OtaLogEntry) => void;

/**
 * Creates an OTA logger instance bound to an optional external callback.
 */
export const createOtaLogger = (onEvent?: OtaEventCallback) => {
  const emit = (
    event: OtaEvent,
    details?: Omit<OtaLogEntry, 'event' | 'timestamp'>,
  ) => {
    const entry: OtaLogEntry = {
      event,
      timestamp: Date.now(),
      ...details,
    };

    // Always log to console for debugging
    const logStr = `[OTA:${event}] ${JSON.stringify(entry)}`;
    console.log(logStr);

    // Also log to native for physical device debugging (visible in Xcode)
    if (NativeBsPatch && NativeBsPatch.logNative) {
      NativeBsPatch.logNative(logStr);
    }

    // Forward to external analytics if configured
    onEvent?.(entry);
  };

  return { emit };
};
