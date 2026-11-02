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
import { ineligibleReason, type EligibilityContext } from './eligibility';
import { getInstallId } from './installId';
import { applyOtaPatchInternal, fetchOtaManifest, selectUpdate, validateOtaConfig } from './otaCore';
import { createOtaLogger, OtaEvent, type OtaLogEntry } from './otaLogger';
import { DOCUMENT_DIR, loadMetadata, markHealthy, nativeString, OTA_DIR } from './otaMetadata';
import {
  OtaConfig,
  OtaMetrics,
  OtaPatch,
  OtaState,
  OtaStatus,
  OtaUpdateMode,
} from './types';

const OtaContext = createContext<OtaState | undefined>(undefined);

const DEFAULT_MIN_CHECK_INTERVAL_MS = 10 * 60 * 1000;

// Screens holding a useOtaReloadBlock (e.g. checkout): a mandatory reload waits for them
let reloadBlocks = 0;
let deferredReload = false;
function reloadMandatory() {
  if (reloadBlocks > 0) {
    deferredReload = true;
    return;
  }
  NativeBsPatch.reloadBundle();
}

/**
 * While mounted (and `blocked`), a mandatory update does not reload the app; it reloads
 * when the last block is released. Use it on screens a reload must not interrupt (payment).
 */
export function useOtaReloadBlock(blocked = true) {
  useEffect(() => {
    if (!blocked) return;
    reloadBlocks++;
    return () => {
      reloadBlocks--;
      // In the background the AppState effect reloads on the next foreground instead
      if (reloadBlocks === 0 && deferredReload && AppState.currentState === 'active') {
        deferredReload = false;
        NativeBsPatch.reloadBundle();
      }
    };
  }, [blocked]);
}

/** Bytecode version the running Hermes reads (undefined off Hermes) */
const hermesBytecodeVersion = (): number | undefined => {
  const v = (globalThis as any).HermesInternal?.getRuntimeProperties?.()?.['Bytecode Version'];
  return v ? Number(v) : undefined;
};

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
  const [isMandatory, setIsMandatory] = useState<boolean>(false);
  const [installId, setInstallId] = useState<string>('');

  const appState = useRef(AppState.currentState);
  const isCheckingRef = useRef(false);
  const bootstrapDone = useRef(false);
  /** Version the native resolver loaded for this JS session */
  const runningVersionRef = useRef(config.baseAppVersion);
  const progressRef = useRef(0);
  const lastCheckRef = useRef(0);
  const appVersionRef = useRef(config.appVersion ?? '');
  const installIdRef = useRef('');
  /** The silent BACKGROUND_DOWNLOAD run, so a foreground install waits for it instead of failing */
  const backgroundRunRef = useRef<Promise<void> | null>(null);
  /** Version the background run prepared for the next launch */
  const preparedVersionRef = useRef(0);
  /** The running foreground install, so a second one (double tap, auto-apply) joins it */
  const foregroundRunRef = useRef<Promise<void> | null>(null);
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

  /** config.onEvent, plus a fire-and-forget POST to config.telemetry.url */
  const onEvent = useCallback((entry: OtaLogEntry) => {
    config.onEvent?.(entry);
    const telemetry = config.telemetry;
    if (!telemetry) return;
    fetch(telemetry.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...telemetry.headers },
      body: JSON.stringify({
        ...entry,
        installId: installIdRef.current,
        platform: Platform.OS,
        appVersion: appVersionRef.current,
        appBuild: nativeString(() => NativeBsPatch.getAppBuild()),
        runtimeFingerprint: nativeString(() => NativeBsPatch.getRuntimeFingerprint()),
        flavor: config.customServer?.channel,
        otaVersion: runningVersionRef.current,
      }),
    }).catch(() => {});
  }, [config]);

  const getEffectiveConfig = useCallback(async (): Promise<OtaConfig> => {
    // The keys `patch` embedded in the app (primary + backup), unless the app passes its own
    const publicKey = config.publicKey || nativeString(() => NativeBsPatch.getEmbeddedPublicKeys()) || undefined;
    const base = { ...config, publicKey, onEvent };
    if (config.appVersion) return base;
    try {
      const nativeVer = await NativeBsPatch.getAppVersion();
      if (!nativeVer) {
        throw new Error('Native appVersion is empty');
      }
      appVersionRef.current = nativeVer;
      return { ...base, appVersion: nativeVer };
    } catch (e) {
      throw new Error(
        `[OtaProvider] Failed to auto-detect appVersion from native: ${(e as Error).message}. ` +
        `Please set versionName (Android) / CFBundleShortVersionString (iOS), or provide config.appVersion explicitly.`
      );
    }
  }, [config, onEvent]);

  /** What decides which registry entries this install may take */
  const eligibilityContext = useCallback(async (): Promise<EligibilityContext> => {
    const metadata = await loadMetadata(config.baseAppVersion);
    return {
      platform: Platform.OS,
      failedVersions: metadata.failedVersions ?? [],
      runtimeFingerprint: nativeString(() => NativeBsPatch.getRuntimeFingerprint()),
      hermesBytecodeVersion: hermesBytecodeVersion(),
      installId: await getInstallId(),
    };
  }, [config.baseAppVersion]);

  /** Installs one registry entry in the foreground (status + progress), then reloads */
  const installEntry = useCallback(
    (directPatch: OtaPatch): Promise<void> => {
      if (foregroundRunRef.current) return foregroundRunRef.current;
      const run = (async () => {
        try {
          setStatus(OtaStatus.DOWNLOADING);
          progressRef.current = 0;
          setProgress(0);
          // otaCore runs one update at a time: let a background download finish first
          if (backgroundRunRef.current) {
            setMessage('Finishing the background download…');
            await backgroundRunRef.current;
          }
          // Already prepared for the next launch: just switch to it
          if (preparedVersionRef.current === directPatch.toVersion) {
            NativeBsPatch.reloadBundle();
            return;
          }
          const effectiveConfig = await getEffectiveConfig();
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
      })().finally(() => {
        foregroundRunRef.current = null;
      });
      foregroundRunRef.current = run;
      return run;
    },
    [getEffectiveConfig, setProgressIfChanged],
  );

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
      await installEntry(directPatch);
    },
    [installEntry],
  );

  /**
   * Installs exactly this registry entry (a version list in a debug/QA screen): the patch
   * when it starts from the running version, else its full bundle. Ignores the kill switch,
   * rollout and QA list; still refuses what would break the app (native code, Hermes, …).
   */
  const applyEntry = useCallback(async (entry: OtaPatch) => {
    if (!isDebugUpdateEnabled) {
      setStatus(OtaStatus.UP_TO_DATE);
      setMessage('OTA updates are disabled while running a debug build.');
      return;
    }
    const reason = ineligibleReason(entry, await eligibilityContext(), { ignoreControls: true });
    if (reason) {
      setStatus(OtaStatus.ERROR);
      setMessage(`Can't install V${entry.toVersion}: ${reason}`);
      return;
    }
    await installEntry(entry);
  }, [eligibilityContext, installEntry, isDebugUpdateEnabled]);

  /**
   * Exposed method for manual trigger
   */
  const applyVersion = useCallback(async (targetVersion: number) => {
    if (!isDebugUpdateEnabled) {
      setPendingCount(0);
      setStatus(OtaStatus.UP_TO_DATE);
      setMessage('OTA updates are disabled while running a debug build.');
      return;
    }
    // From the installed version: a background install may have moved it past the running one
    const { currentVersion: localV } = await loadMetadata(config.baseAppVersion);
    await executeApplyUpdate(patches, localV, targetVersion);
  }, [config.baseAppVersion, executeApplyUpdate, isDebugUpdateEnabled, patches]);

  const applyUpdate = useCallback(
    () => applyVersion(latestVersion),
    [applyVersion, latestVersion],
  );

  const downloadBackgroundUpdate = useCallback(
    async (
      patchList: OtaPatch[],
      localV: number,
      targetV: number,
    ) => {
      const directPatch = selectUpdate(patchList, localV, targetV);
      if (!directPatch || backgroundRunRef.current || preparedVersionRef.current === targetV) return;

      const run = (async () => {
        const effectiveConfig = await getEffectiveConfig();
        await applyOtaPatchInternal(
          directPatch,
          effectiveConfig,
          (s: OtaStatus, msg: string, m?: OtaMetrics) => {
            if (s === OtaStatus.SUCCESS) {
              preparedVersionRef.current = targetV;
              setIsUpdateReady(true);
              setStatus(OtaStatus.UP_TO_DATE);
              setMessage(`Update V${targetV} ready for next launch`);
              if (m) setMetrics(m);
              if (directPatch.mandatory) {
                setIsMandatory(true);
                // Only in the foreground: a reload in the background is rolled back (see the
                // AppState effect); the effect reloads once the app comes back
                if (AppState.currentState === 'active') reloadMandatory();
              }
            }
          },
          () => {}, // silent: background doesn't spam progress
          { autoReload: false }, // Do NOT reload immediately
        );
      })().catch(e => {
        if (__DEV__) {
          console.warn('[OtaProvider] Silent background update failed:', e);
        }
      }).finally(() => {
        backgroundRunRef.current = null;
      });
      backgroundRunRef.current = run;
      await run;
    },
    [getEffectiveConfig],
  );

  /**
   * Check for updates from the manifest.
   * Uses a ref to guard against concurrent calls (avoids stale closure).
   * Automatic calls are throttled by minCheckIntervalMs; { force: true } always checks.
   */
  const checkUpdates = useCallback(async (options?: { force?: boolean }) => {
    if (isCheckingRef.current || configError) return;
    if (!isDebugUpdateEnabled) {
      setPendingCount(0);
      setIsChecking(false);
      setStatus(OtaStatus.UP_TO_DATE);
      setMessage('OTA updates are disabled while running a debug build.');
      return;
    }
    const minInterval = config.minCheckIntervalMs ?? DEFAULT_MIN_CHECK_INTERVAL_MS;
    if (!options?.force && Date.now() - lastCheckRef.current < minInterval) return;
    lastCheckRef.current = Date.now();
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

      // Storage providers return every platform: keep what this install may take (platform,
      // native fingerprint, Hermes, rollout/QA lists, kill switch, versions that crashed here)
      const context = await eligibilityContext();
      const platformPatches = remotePatches.filter(p => {
        const reason = ineligibleReason(p, context);
        if (reason && __DEV__ && p.toVersion > localV) {
          console.log(`[OtaProvider] Skipping V${p.toVersion} (${p.id}): ${reason}`);
        }
        return !reason;
      });

      const maxV =
        platformPatches.length > 0
          ? Math.max(...platformPatches.map(p => p.toVersion))
          : localV;

      setPatches(platformPatches);
      // localV is ahead of the running version once a background install committed
      setCurrentVersion(runningVersionRef.current);
      setLatestVersion(maxV);

      if (maxV > localV) {
        setPendingCount(1);
        setMessage(`Update available: V${localV} → V${maxV}`);
        setStatus(OtaStatus.UPDATE_AVAILABLE);

        // Trigger behaviors based on mode
        const network = config.network?.wifiOnly
          ? await NativeBsPatch.getNetworkType().catch(() => 'unknown')
          : 'wifi';
        if (network !== 'wifi' && network !== 'ethernet') {
          setMessage(`Update available: V${localV} → V${maxV} (waiting for Wi-Fi)`);
          // Nothing re-checks on a network change: ON_APP_START must not keep the loading view up
          if (config.updateMode === OtaUpdateMode.ON_APP_START) setStatus(OtaStatus.UP_TO_DATE);
        } else if (config.updateMode === OtaUpdateMode.BACKGROUND_DOWNLOAD) {
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
        setMessage(
          localV !== runningVersionRef.current
            ? `Update V${localV} ready for next launch`
            : `All systems nominal (V${localV})`,
        );
        setStatus(OtaStatus.UP_TO_DATE);
      }
    } catch (error) {
      setMessage(`Check failed: ${(error as Error).message}`);
      setStatus(OtaStatus.ERROR);
    } finally {
      isCheckingRef.current = false;
      setIsChecking(false);
    }
  }, [config, configError, eligibilityContext, executeApplyUpdate, isDebugUpdateEnabled, downloadBackgroundUpdate, getEffectiveConfig]);

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
      getInstallId().then(id => {
        installIdRef.current = id;
        setInstallId(id);
      }).catch(() => {});

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

    // OTA must never take the app down: if bootstrap fails, render the app with OTA idle
    bootstrap()
      .catch(error => {
        console.warn('[OtaProvider] Bootstrap failed, OTA disabled for this session:', error);
        setMessage(`OTA disabled: ${(error as Error).message}`);
        setStatus(OtaStatus.ERROR);
      })
      .finally(() => setIsInitialized(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * AppState listener for ON_APP_FOREGROUND mode, and for a mandatory update that got
   * ready while in the background.
   * A downloaded update is not reloaded on background: iOS suspends JS before the
   * first render, so the native resolver counts the launch as failed and rolls it back.
   * metadata already points at the new version, so the next cold start applies it
   */
  const isMandatoryRef = useRef(false);
  isMandatoryRef.current = isMandatory && isUpdateReady;
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (nextAppState: AppStateStatus) => {
        if (
          appState.current.match(/inactive|background/) &&
          nextAppState === 'active' &&
          bootstrapDone.current
        ) {
          if (isMandatoryRef.current) {
            reloadMandatory();
            return;
          }
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
    const log = createOtaLogger(onEvent);
    log.emit(OtaEvent.MARK_HEALTHY);
    const appVersion = await NativeBsPatch.getAppVersion().catch(() => config.appVersion);
    await markHealthy(config.baseAppVersion, runningVersionRef.current, appVersion);
  }, [config, onEvent]);

  const resetToFactory = useCallback(async () => {
    const log = createOtaLogger(onEvent);
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
  }, [onEvent]);

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
    isMandatory,
    installId,
    applyUpdate,
    applyVersion,
    applyEntry,
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
    isMandatory,
    installId,
    applyUpdate,
    applyVersion,
    applyEntry,
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
            status === OtaStatus.SYNCING_ASSETS ||
            status === OtaStatus.SUCCESS || // reload pending
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
