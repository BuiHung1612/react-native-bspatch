import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import NativeBsPatch from '../NativeBsPatch';
import { applyOtaPatchInternal, fetchOtaManifest, selectUpdate, validateOtaConfig } from './otaCore';
import { createOtaLogger, OtaEvent } from './otaLogger';
import { DOCUMENT_DIR, loadMetadata, markHealthy, OTA_DIR } from './otaMetadata';
import {
  OtaConfig,
  OtaMetrics,
  OtaPatch,
  OtaState,
  OtaStatus,
  OtaUpdateMode,
} from './types';

const OtaContext = createContext<OtaState | undefined>(undefined);

export function OtaProvider({
  children,
  config,
  loadingView,
  useLoadingView = true,
}: {
  children: React.ReactNode;
  config: OtaConfig;
  loadingView?: React.ReactNode;
  useLoadingView?: boolean;
}) {
  const [status, setStatus] = useState<OtaStatus>(OtaStatus.IDLE);
  const [message, setMessage] = useState<string>('Initializing...');
  const [progress, setProgress] = useState<number>(0);

  const [currentVersion, setCurrentVersion] = useState<number>(
    config.baseAppVersion,
  );
  const [latestVersion, setLatestVersion] = useState<number>(
    config.baseAppVersion,
  );
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [metrics, setMetrics] = useState<OtaMetrics | null>(null);
  const [patches, setPatches] = useState<OtaPatch[]>([]);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const [isUpdateReady, setIsUpdateReady] = useState<boolean>(false);

  const appState = useRef(AppState.currentState);
  const isCheckingRef = useRef(false);
  const pendingReloadRef = useRef(false);
  const bootstrapDone = useRef(false);
  /** Version the native resolver loaded for this JS session */
  const runningVersionRef = useRef(config.baseAppVersion);
  const progressRef = useRef(0);
  const isDebugUpdateEnabled = !__DEV__ || config.allowDebugUpdates === true;

  // No fallbacks: a missing env value disables OTA instead of silently pointing elsewhere.
  // Dev: throw during render (red box). Release: the app runs, OTA never checks or downloads.
  const configError = useMemo(() => {
    const e = validateOtaConfig(config);
    return e && `[react-native-bspatch] OTA disabled: ${e}`;
  }, [config]);
  if (__DEV__ && configError) {
    throw new Error(configError);
  }

  const setProgressIfChanged = useCallback((nextProgress: number) => {
    if (progressRef.current === nextProgress) {
      return;
    }
    progressRef.current = nextProgress;
    setProgress(nextProgress);
  }, []);

  const getEffectiveConfig = useCallback(async (): Promise<OtaConfig> => {
    if (config.appVersion) return config;
    try {
      const nativeVer = await NativeBsPatch.getAppVersion();
      if (!nativeVer) {
        throw new Error('Native appVersion is empty');
      }
      return { ...config, appVersion: nativeVer };
    } catch (e) {
      throw new Error(
        `[OtaProvider] Failed to auto-detect appVersion from native: ${(e as Error).message}. ` +
        `Please set versionName (Android) / CFBundleShortVersionString (iOS), or provide config.appVersion explicitly.`
      );
    }
  }, [config]);

  /**
   * Core apply update logic — separated so it can be mapped to button clicks
   * OR called automatically by checkUpdates()
   */
  const executeApplyUpdate = useCallback(
    async (patchList: OtaPatch[], currentVer: number, targetVer: number) => {
      const directPatch = selectUpdate(patchList, currentVer, targetVer);

      if (!directPatch) {
        if (__DEV__) {
          console.warn('[OtaProvider] No update entry found for', currentVer, '->', targetVer);
        }
        setStatus(OtaStatus.ERROR);
        setMessage('No upgrade path found.');
        return;
      }

      try {
        const effectiveConfig = await getEffectiveConfig();
        setStatus(OtaStatus.DOWNLOADING);
        progressRef.current = 0;
        setProgress(0);
        await applyOtaPatchInternal(
          directPatch,
          effectiveConfig,
          (s: OtaStatus, msg: string, m?: OtaMetrics) => {
            setMessage(msg);
            setStatus(s);
            if (m) setMetrics(m);
          },
          (percent: number) => {
            setProgressIfChanged(percent);
          },
        );
      } catch (error) {
        if (__DEV__) {
          console.error('[OtaProvider] Update error:', error);
        }
        setStatus(OtaStatus.ERROR);
        setMessage(`Update failed: ${(error as Error).message}`);
      }
    },
    [getEffectiveConfig, setProgressIfChanged],
  );

  /**
   * Exposed method for manual trigger
   */
  const applyUpdate = useCallback(async () => {
    if (!isDebugUpdateEnabled) {
      setPendingCount(0);
      setStatus(OtaStatus.UP_TO_DATE);
      setMessage('OTA updates are disabled while running a debug build.');
      return;
    }
    await executeApplyUpdate(patches, currentVersion, latestVersion);
  }, [
    currentVersion,
    executeApplyUpdate,
    isDebugUpdateEnabled,
    latestVersion,
    patches,
  ]);

  const downloadBackgroundUpdate = useCallback(
    async (
      patchList: OtaPatch[],
      localV: number,
      targetV: number,
    ) => {
      const directPatch = selectUpdate(patchList, localV, targetV);
      if (!directPatch) return;

      try {
        const effectiveConfig = await getEffectiveConfig();
        await applyOtaPatchInternal(
          directPatch,
          effectiveConfig,
          (s: OtaStatus, msg: string, m?: OtaMetrics) => {
            if (s === OtaStatus.SUCCESS) {
              setIsUpdateReady(true);
              pendingReloadRef.current = true;
              setStatus(OtaStatus.UP_TO_DATE);
              setMessage(`Update V${targetV} ready for next launch`);
              if (m) setMetrics(m);
            }
          },
          () => {}, // silent: background doesn't spam progress
          { autoReload: false }, // Do NOT reload immediately
        );
      } catch (e) {
        if (__DEV__) {
          console.warn('[OtaProvider] Silent background update failed:', e);
        }
      }
    },
    [getEffectiveConfig],
  );

  /**
   * Check for updates from the manifest.
   * Uses a ref to guard against concurrent calls (avoids stale closure).
   */
  const checkUpdates = useCallback(async () => {
    if (isCheckingRef.current || configError) return;
    if (!isDebugUpdateEnabled) {
      setPendingCount(0);
      setIsChecking(false);
      setStatus(OtaStatus.UP_TO_DATE);
      setMessage('OTA updates are disabled while running a debug build.');
      return;
    }
    isCheckingRef.current = true;
    setIsChecking(true);
    setStatus(OtaStatus.CHECKING);
    setMessage('Checking for updates...');

    try {
      const effectiveConfig = await getEffectiveConfig();
      createOtaLogger(effectiveConfig.onEvent).emit(OtaEvent.CHECK_UPDATE);
      const remotePatches = await fetchOtaManifest(effectiveConfig);
      const metadata = await loadMetadata(config.baseAppVersion);
      const localV = metadata.currentVersion;

      // The one platform filter (storage providers return every platform).
      // Also skips versions that crashed on boot and were rolled back natively.
      const failed = metadata.failedVersions ?? [];
      const platformPatches = remotePatches.filter(
        p =>
          (!p.platform || p.platform.toLowerCase() === Platform.OS) &&
          !failed.includes(p.toVersion),
      );

      const maxV =
        platformPatches.length > 0
          ? Math.max(...platformPatches.map(p => p.toVersion))
          : localV;

      setPatches(platformPatches);
      setCurrentVersion(localV);
      setLatestVersion(maxV);

      if (maxV > localV) {
        setPendingCount(1);
        setMessage(`Update available: V${localV} → V${maxV}`);
        setStatus(OtaStatus.UPDATE_AVAILABLE);

        // Trigger behaviors based on mode
        if (config.updateMode === OtaUpdateMode.BACKGROUND_DOWNLOAD) {
          downloadBackgroundUpdate(platformPatches, localV, maxV);
        } else if (
          config.updateMode === OtaUpdateMode.ON_APP_START ||
          config.updateMode === OtaUpdateMode.ON_APP_FOREGROUND
        ) {
          // Auto-apply immediately!
          await executeApplyUpdate(platformPatches, localV, maxV);
        }
      } else {
        setPendingCount(0);
        setMessage(`All systems nominal (V${localV})`);
        setStatus(OtaStatus.UP_TO_DATE);
      }
    } catch (error) {
      setMessage(`Check failed: ${(error as Error).message}`);
      setStatus(OtaStatus.ERROR);
    } finally {
      isCheckingRef.current = false;
      setIsChecking(false);
    }
  }, [config, configError, executeApplyUpdate, isDebugUpdateEnabled, downloadBackgroundUpdate, getEffectiveConfig]);

  /**
   * Bootstrap: runs once on mount.
   *
   * Lifecycle:
   *  1. Load metadata
   *  2. Check if previous launch failed → rollback if needed
   *  3. Mark current launch as "pending verification" (lastLaunchSuccessful=false)
   *  4. App renders → markAsHealthy() sets it back to true
   *  5. If crash before markAsHealthy → next boot sees false → rollback
   *  6. Check for updates based on updateMode
   */
  useEffect(() => {
    const bootstrap = async () => {
      // Clean up any pending trash directories from previous resets (non-blocking)
      NativeBsPatch.readDir(DOCUMENT_DIR).then(dirs => {
        for (const dir of dirs) {
          if (dir.startsWith('ota_trash_')) {
            NativeBsPatch.removePath(`${DOCUMENT_DIR}/${dir}`).catch(() => {});
          }
        }
      }).catch(() => {});

      const metadata = await loadMetadata(config.baseAppVersion);
      runningVersionRef.current = metadata.currentVersion;

      // Display current version immediately
      setCurrentVersion(metadata.currentVersion);

      // (Native layer handled crash detection and any necessary rollback)
      if (configError) {
        console.error(configError);
        setMessage(configError);
        setStatus(OtaStatus.ERROR);
        return;
      }
      bootstrapDone.current = true;

      // Mode-based auto-check
      const mode = config.updateMode ?? OtaUpdateMode.MANUAL;
      if (
        mode === OtaUpdateMode.ON_APP_START ||
        mode === OtaUpdateMode.BACKGROUND_DOWNLOAD
      ) {
        checkUpdates();
      } else {
        setMessage(`Ready (V${metadata.currentVersion})`);
        setStatus(OtaStatus.UP_TO_DATE);
      }
    };

    bootstrap().then(() => setIsInitialized(true)).catch(() => {
      // Bootstrap failed: keep UI blocked so user sees the error state.
      // setIsInitialized stays false → isBlocking remains true → the error
      // message is shown via loadingView instead of a silent blank screen.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * AppState listener for ON_APP_FOREGROUND mode and silent background reload
   */
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (nextAppState: AppStateStatus) => {
        // When going into background: if update is downloaded and ready, reload bundle silently
        // Only 'background', not 'inactive' (iOS fires it for Control Center, calls,
        // Face ID). Any previous state: iOS goes active → inactive → background.
        if (nextAppState === 'background' && pendingReloadRef.current) {
          pendingReloadRef.current = false;
          NativeBsPatch.reloadBundle();
        }

        if (
          appState.current.match(/inactive|background/) &&
          nextAppState === 'active' &&
          bootstrapDone.current
        ) {
          const mode = config.updateMode ?? OtaUpdateMode.MANUAL;
          if (mode === OtaUpdateMode.ON_APP_FOREGROUND) {
            checkUpdates();
          }
        }
        appState.current = nextAppState;
      },
    );

    return () => {
      subscription.remove();
    };
  }, [config.updateMode, checkUpdates]);

  const markAsHealthy = useCallback(async () => {
    const log = createOtaLogger(config.onEvent);
    log.emit(OtaEvent.MARK_HEALTHY);
    const appVersion = await NativeBsPatch.getAppVersion().catch(() => config.appVersion);
    await markHealthy(config.baseAppVersion, runningVersionRef.current, appVersion);
  }, [config]);

  const resetToFactory = useCallback(async () => {
    const log = createOtaLogger(config.onEvent);
    try {
      setStatus(OtaStatus.APPLYING);
      setMessage('Executing system wipe...');
      log.emit(OtaEvent.RESET_FACTORY);
      if (await NativeBsPatch.exists(OTA_DIR)) {
        // Fast atomic rename to prevent blocking the JS thread during deletion of potentially 1000s of files
        await NativeBsPatch.moveFile(OTA_DIR, `${DOCUMENT_DIR}/ota_trash_${Date.now()}`);
        // Deletion is deferred to the next app bootstrap to prevent blocking the bridge before reload
      }
      setMessage('Reset complete. Core reload initiated...');
      NativeBsPatch.reloadBundle();
    } catch (error) {
      setStatus(OtaStatus.ERROR);
      setMessage(`Reset failed: ${(error as Error).message}`);
    }
  }, [config]);

  // Memoized: consumers re-render only when something they can see changes
  const value = useMemo<OtaState>(() => ({
    status,
    message,
    progress,
    currentVersion,
    latestVersion,
    pendingCount,
    isChecking,
    metrics,
    isUpdateReady,
    applyUpdate,
    resetToFactory,
    markAsHealthy,
    checkUpdate: checkUpdates,
    reloadBundle: () => NativeBsPatch.reloadBundle(),
  }), [
    status,
    message,
    progress,
    currentVersion,
    latestVersion,
    pendingCount,
    isChecking,
    metrics,
    isUpdateReady,
    applyUpdate,
    resetToFactory,
    markAsHealthy,
    checkUpdates,
  ]);

  // Logic to determine if we should block the UI
  const isBlocking = useMemo(() => {
    return (
      useLoadingView &&
      (!isInitialized ||
        (config.updateMode === OtaUpdateMode.ON_APP_START &&
          (status === OtaStatus.IDLE ||
            status === OtaStatus.CHECKING ||
            status === OtaStatus.DOWNLOADING ||
            status === OtaStatus.APPLYING ||
            status === OtaStatus.UPDATE_AVAILABLE)))
    );
  }, [useLoadingView, isInitialized, config.updateMode, status]);

  // Mark healthy only after the app's own tree has committed its first render.
  // This effect runs after all child effects, so a bundle that throws while
  // rendering never gets here and the native resolver rolls it back next boot.
  const healthyMarkedRef = useRef(false);
  useEffect(() => {
    if (isBlocking || !isInitialized || healthyMarkedRef.current) return;
    healthyMarkedRef.current = true;
    markAsHealthy().catch(e => console.warn('[OtaProvider] markAsHealthy failed:', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBlocking, isInitialized]);

  return (
    <OtaContext.Provider value={value}>
      {!isBlocking ? (
        children
      ) : loadingView !== undefined ? (
        loadingView
      ) : (
        <View style={styles.loadingContainer}>
          <View style={styles.loadingCard}>
            <ActivityIndicator size="large" color="#111111" />
            <Text style={styles.loadingTitle}>Please wait</Text>
            <Text style={styles.loadingText}>{message}</Text>
            {status === OtaStatus.DOWNLOADING || status === OtaStatus.APPLYING ? (
              <Text style={styles.progressText}>{progress.toFixed(1)}%</Text>
            ) : null}
          </View>
        </View>
      )}
    </OtaContext.Provider>
  );
}

export function useOta() {
  const context = useContext(OtaContext);
  if (context === undefined) {
    throw new Error('useOta must be used within an OtaProvider');
  }
  return context;
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F5F5F5',
    paddingHorizontal: 24,
  },
  loadingCard: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: 24,
    paddingVertical: 28,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E5E5',
  },
  loadingTitle: {
    marginTop: 16,
    color: '#111111',
    fontSize: 18,
    fontWeight: '600',
  },
  loadingText: {
    marginTop: 8,
    color: '#4A4A4A',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  progressText: {
    marginTop: 20,
    color: '#111111',
    fontSize: 16,
    fontWeight: '600',
  },
});
