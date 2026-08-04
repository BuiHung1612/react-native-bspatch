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
import ReactNativeBlobUtil from 'react-native-blob-util';
import NativeBsPatch from '../NativeBsPatch';
import { initOtaAssetResolver } from './otaAssetResolver';
import { applyOtaPatchInternal, fetchOtaManifest } from './otaCore';
import { createOtaLogger, OtaEvent } from './otaLogger';
import { loadMetadata, markHealthy } from './otaMetadata';
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

  const appState = useRef(AppState.currentState);
  const isCheckingRef = useRef(false);
  const bootstrapDone = useRef(false);

  /**
   * Core apply update logic — separated so it can be mapped to button clicks
   * OR called automatically by checkUpdates()
   */
  const executeApplyUpdate = useCallback(
    async (patchList: OtaPatch[], currentVer: number, targetVer: number) => {
      console.log('[OtaProvider] executeApplyUpdate | targetV:', targetVer, 'currentV:', currentVer);
      const directPatch = patchList.find(
        p => p.fromVersion === currentVer &&
             p.toVersion === targetVer &&
             p.platform === Platform.OS,
      );

      if (!directPatch) {
        console.warn('[OtaProvider] No direct patch found for', currentVer, '->', targetVer);
        setStatus(OtaStatus.ERROR);
        setMessage('No direct upgrade path found.');
        return;
      }

      try {
        setStatus(OtaStatus.DOWNLOADING);
        setProgress(0);
        await applyOtaPatchInternal(
          directPatch,
          config,
          (s: OtaStatus, msg: string, m?: OtaMetrics) => {
            setMessage(msg);
            setStatus(s);
            if (m) {
              setMetrics(m);
              // Initialize asset resolver for the new version immediately
              initOtaAssetResolver(targetVer);
            }
          },
          (percent: number) => {
            setProgress(percent);
          },
        );
      } catch (error) {
        console.error('[OtaProvider] Update error:', error);
        setStatus(OtaStatus.ERROR);
        setMessage(`Update failed: ${(error as Error).message}`);
      }
    },
    [config],
  );

  /**
   * Exposed method for manual trigger
   */
  const applyUpdate = useCallback(async () => {
    await executeApplyUpdate(patches, currentVersion, latestVersion);
  }, [executeApplyUpdate, patches, currentVersion, latestVersion]);

  /**
   * Check for updates from the manifest.
   * Uses a ref to guard against concurrent calls (avoids stale closure).
   */
  const checkUpdates = useCallback(async () => {
    if (isCheckingRef.current) return;
    isCheckingRef.current = true;
    setIsChecking(true);
    setStatus(OtaStatus.CHECKING);
    setMessage('Checking for updates...');

    const log = createOtaLogger(config.onEvent);
    log.emit(OtaEvent.CHECK_UPDATE);

    try {
      const remotePatches = await fetchOtaManifest(config);
      const metadata = await loadMetadata(config.baseAppVersion);
      const localV = metadata.currentVersion;
      console.log('[OtaProvider] checkUpdates | localV:', localV, 'remotePatches count:', remotePatches.length);

      const platformPatches = remotePatches.filter(p => p.platform === Platform.OS);
      console.log('[OtaProvider] platformPatches count:', platformPatches.length);

      const maxV =
        platformPatches.length > 0
          ? Math.max(...platformPatches.map(p => p.toVersion))
          : localV;
      
      console.log('[OtaProvider] latestV determined:', maxV);

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
  }, [config, executeApplyUpdate]);

  const downloadBackgroundUpdate = async (
    patchList: OtaPatch[],
    localV: number,
    targetV: number,
  ) => {
    const directPatch = patchList.find(
      p => p.fromVersion === localV && p.toVersion === targetV,
    );
    if (!directPatch) return;

    console.warn(
      '[OtaProvider] BACKGROUND_DOWNLOAD mode is not yet implemented. ' +
      'Patches were found but no download occurred. ' +
      'Use MANUAL or ON_APP_START mode for now.',
    );
  };

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
      ReactNativeBlobUtil.fs.ls(ReactNativeBlobUtil.fs.dirs.DocumentDir).then(dirs => {
        for (const dir of dirs) {
          if (dir.startsWith('ota_trash_')) {
            ReactNativeBlobUtil.fs.unlink(`${ReactNativeBlobUtil.fs.dirs.DocumentDir}/${dir}`).catch(() => {});
          }
        }
      }).catch(() => {});

      const metadata = await loadMetadata(config.baseAppVersion);

      // Display current version immediately
      setCurrentVersion(metadata.currentVersion);

      // Initialize asset resolver with current version (if not base)
      if (metadata.currentVersion > config.baseAppVersion) {
        await initOtaAssetResolver(metadata.currentVersion);
      }

      // (Native layer handled crash detection and any necessary rollback)
      // We just mark bootstrap as done
      bootstrapDone.current = true;

      // Always mark as healthy after a successful JS bootstrap.
      //
      // The native OtaBundleResolver uses its own baseVersion (DEFAULT_BASE_VERSION=1),
      // independent of the JS-side config.baseAppVersion. It marks
      // lastLaunchSuccessful=false before loading ANY OTA bundle (even when
      // JS baseAppVersion has been bumped to match currentVersion). If we only
      // call markAsHealthy when currentVersion > JS baseAppVersion, we miss this
      // case and the native layer will rollback on the very next cold boot.
      //
      // markAsHealthy() is safe to call unconditionally — it's a no-op when
      // the metadata already has lastLaunchSuccessful=true.
      console.log(`[OtaProvider] Marking V${metadata.currentVersion} as healthy`);
      await markAsHealthy();

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
   * AppState listener for ON_APP_FOREGROUND mode
   */
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (nextAppState: AppStateStatus) => {
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

  const markAsHealthy = async () => {
    const log = createOtaLogger(config.onEvent);
    log.emit(OtaEvent.MARK_HEALTHY);
    await markHealthy(config.baseAppVersion);
    NativeBsPatch.markAsHealthy();
  };

  const resetToFactory = async () => {
    const log = createOtaLogger(config.onEvent);
    try {
      setStatus(OtaStatus.APPLYING);
      setMessage('Executing system wipe...');
      log.emit(OtaEvent.RESET_FACTORY);
      const otaDir = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/ota`;
      if (await ReactNativeBlobUtil.fs.exists(otaDir)) {
        // Fast atomic rename to prevent blocking the JS thread during deletion of potentially 1000s of files
        const trashDir = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/ota_trash_${Date.now()}`;
        await ReactNativeBlobUtil.fs.mv(otaDir, trashDir);
        // Deletion is deferred to the next app bootstrap to prevent blocking the bridge before reload
      }
      setMessage('Reset complete. Core reload initiated...');
      NativeBsPatch.reloadBundle();
    } catch (error) {
      setStatus(OtaStatus.ERROR);
      setMessage(`Reset failed: ${(error as Error).message}`);
    }
  };

  const value: OtaState = {
    status,
    message,
    progress,
    currentVersion,
    latestVersion,
    pendingCount,
    isChecking,
    metrics,
    applyUpdate,
    resetToFactory,
    markAsHealthy,
    checkUpdate: checkUpdates,
  };

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

  return (
    <OtaContext.Provider value={value}>
      {!isBlocking ? (
        children
      ) : loadingView !== undefined ? (
        loadingView
      ) : (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#FF00F5" />
          <Text style={styles.loadingText}>{message}</Text>
          {status === OtaStatus.DOWNLOADING || status === OtaStatus.APPLYING ? (
            <Text style={styles.progressText}>{progress.toFixed(1)}%</Text>
          ) : null}
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
    backgroundColor: '#000',
  },
  loadingText: {
    marginTop: 20,
    color: '#00FFCC',
    fontSize: 16,
  },
  progressText: {
    marginTop: 10,
    color: '#fff',
  },
});
