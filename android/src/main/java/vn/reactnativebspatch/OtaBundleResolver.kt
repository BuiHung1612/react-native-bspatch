package vn.reactnativebspatch

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * OtaBundleResolver — encapsulates OTA bundle path resolution with
 * crash detection and automatic rollback.
 *
 * IMPORTANT: This runs BEFORE any JS code. If the OTA bundle is corrupted,
 * Hermes crashes before React Native boots. This native resolver handles
 * crash detection so the app can recover without JS ever running.
 *
 * Lifecycle:
 *   1. Read metadata.json
 *   2. If lastLaunchSuccessful == false → retry the same version up to MAX_LAUNCH_ATTEMPTS,
 *      then rollback to previous version
 *   3. Mark current launch as pending (lastLaunchSuccessful = false)
 *   4. Return the bundle path (or null for APK default)
 *   5. JS marks healthy after first render → lastLaunchSuccessful = true, verifiedVersion = current
 *   6. If crash before that → next boot sees false → rollback
 *   7. A verified version is never marked pending again (later crashes/kills don't roll it back)
 *
 * Usage in MainApplication.kt:
 * ```
 * jsBundleFilePath = OtaBundleResolver.resolve(applicationContext)
 * ```
 */
object OtaBundleResolver {

    private const val TAG = "OtaBundleResolver"
    private const val OTA_DIR_NAME = "ota"
    private const val METADATA_FILE = "metadata.json"
    private const val DEFAULT_BASE_VERSION = 1
    private const val MAX_ROLLBACK = 3
    /** Unverified launches allowed before rollback: a kill before first render is indistinguishable from a crash */
    private const val MAX_LAUNCH_ATTEMPTS = 3

    /** Version this process booted (set by resolve), so markAsHealthy verifies only that one */
    @Volatile private var launchedVersion: Int? = null

    /**
     * Resolves the JS bundle path from OTA metadata.
     * Handles crash detection and rollback entirely on the native side.
     *
     * @param context Android Application context
     * @param baseVersion The OTA version baked into the APK (default: 1)
     * @return Absolute path to the OTA bundle, or null to use the APK default.
     */
    @JvmStatic
    fun resolve(context: Context, baseVersion: Int = DEFAULT_BASE_VERSION): String? {
        val path = resolveBundle(context, baseVersion)
        launchedVersion = path?.let { File(it).parentFile?.name?.removePrefix("v")?.toIntOrNull() } ?: baseVersion
        return path
    }

    private fun resolveBundle(context: Context, baseVersion: Int): String? {
        return try {
            val otaDir = File(context.filesDir, OTA_DIR_NAME)
            val metadataFile = File(otaDir, METADATA_FILE)

            if (!metadataFile.exists()) {
                Log.d(TAG, "No OTA metadata → APK bundle")
                return null
            }

            var metadata = JSONObject(metadataFile.readText())

            // ── Step 0: Store update → OTA bundles were built for another native version ──
            val otaAppVersion = metadata.optString("appVersion", "")
            val installedAppVersion = context.packageManager
                .getPackageInfo(context.packageName, 0).versionName ?: ""
            if (otaAppVersion.isNotEmpty() && otaAppVersion != installedAppVersion) {
                Log.i(TAG, "Native app $otaAppVersion → $installedAppVersion: discarding OTA state")
                // JS bootstrap deletes ota_trash_* in the background
                otaDir.renameTo(File(context.filesDir, "ota_trash_${System.currentTimeMillis()}"))
                return null
            }

            val currentVersion = metadata.optInt("currentVersion", baseVersion)
            val lastLaunchOk = metadata.optBoolean("lastLaunchSuccessful", true)
            val rollbackCount = metadata.optInt("rollbackCount", 0)
            // Verified = launched and rendered before; never pending, never rolled back
            val verifiedVersion = metadata.optInt("verifiedVersion", -1)

            // ── Step 1: Crash detection & rollback ──────────────────────────
            val launchAttempts = metadata.optInt("launchAttempts", 1)
            val currentBundle = File(File(otaDir, "v${currentVersion}"), "index.android.bundle")
            if (!lastLaunchOk && currentVersion > baseVersion && launchAttempts < MAX_LAUNCH_ATTEMPTS &&
                currentBundle.exists()) {
                metadata.put("launchAttempts", launchAttempts + 1)
                writeMetadata(metadataFile, metadata)
                Log.w(TAG, "Previous launch of V$currentVersion not verified → retry ${launchAttempts + 1}/$MAX_LAUNCH_ATTEMPTS")
                return currentBundle.absolutePath
            }

            if (!lastLaunchOk && currentVersion > baseVersion) {
                Log.w(TAG, "Previous launch failed! Rolling back from V$currentVersion...")
                // Remember the crashing version so JS never re-applies it
                val failed = metadata.optJSONArray("failedVersions") ?: JSONArray()
                failed.put(currentVersion)
                metadata = performRollback(metadata, baseVersion, rollbackCount, otaDir)
                metadata.put("failedVersions", failed)
                metadata.put("appVersion", otaAppVersion)
                if (verifiedVersion >= 0) metadata.put("verifiedVersion", verifiedVersion)
                writeMetadata(metadataFile, metadata)

                val newVersion = metadata.optInt("currentVersion", baseVersion)
                if (newVersion <= baseVersion) {
                    Log.i(TAG, "Rolled back to factory APK bundle")
                    return null
                }

                // Check if the rollback target bundle exists
                val rollbackVDir = File(otaDir, "v${newVersion}")
                val rollbackBundle = File(rollbackVDir, "index.android.bundle")
                if (!rollbackBundle.exists()) {
                    Log.w(TAG, "Rollback target index.android.bundle missing in V$newVersion → factory")
                    resetToFactory(metadataFile, baseVersion, metadata)
                    return null
                }

                // Mark this rollback attempt as pending
                if (newVersion != verifiedVersion) {
                    metadata.put("lastLaunchSuccessful", false)
                    metadata.put("launchAttempts", 1)
                    writeMetadata(metadataFile, metadata)
                }

                Log.i(TAG, "Trying rollback bundle: ${rollbackBundle.absolutePath}")
                return rollbackBundle.absolutePath
            }

            // ── Step 2: Normal boot — no OTA bundle needed ──────────────────
            if (currentVersion <= baseVersion) {
                Log.d(TAG, "OTA v$currentVersion ≤ base v$baseVersion → APK bundle")
                return null
            }

            // ── Step 3: OTA bundle — mark as pending verification ───────────
            val vDir = File(otaDir, "v${currentVersion}")
            val bundleFile = File(vDir, "index.android.bundle")
            if (!bundleFile.exists()) {
                Log.w(TAG, "index.android.bundle missing in V$currentVersion → APK bundle")
                resetToFactory(metadataFile, baseVersion, metadata)
                return null
            }

            // Mark launch as pending — if Hermes crashes loading this bundle,
            // the next boot will see false and trigger rollback
            if (currentVersion != verifiedVersion) {
                metadata.put("lastLaunchSuccessful", false)
                metadata.put("launchAttempts", 1)
                writeMetadata(metadataFile, metadata)
            }

            Log.i(TAG, "Loading OTA bundle: ${bundleFile.absolutePath}")
            bundleFile.absolutePath
        } catch (e: Exception) {
            Log.e(TAG, "Error resolving OTA bundle: ${e.message}")
            null
        }
    }

    /**
     * Performs rollback by popping from previousVersions.
     * If maxRollback reached, resets to factory.
     */
    private fun performRollback(
        metadata: JSONObject,
        baseVersion: Int,
        currentRollbackCount: Int,
        otaDir: File
    ): JSONObject {
        val newCount = currentRollbackCount + 1

        // Max rollback reached → factory reset
        if (newCount >= MAX_ROLLBACK) {
            Log.w(TAG, "Max rollback ($MAX_ROLLBACK) reached → factory reset")
            return JSONObject().apply {
                put("currentVersion", baseVersion)
                put("previousVersions", JSONArray())
                put("rollbackCount", 0)
                put("lastLaunchSuccessful", true)
            }
        }

        val prevVersions = metadata.optJSONArray("previousVersions") ?: JSONArray()

        if (prevVersions.length() == 0) {
            Log.w(TAG, "No previous versions to rollback to → factory reset")
            return JSONObject().apply {
                put("currentVersion", baseVersion)
                put("previousVersions", JSONArray())
                put("rollbackCount", newCount)
                put("lastLaunchSuccessful", true)
            }
        }

        // Pop the first previous version
        val rollbackTo = prevVersions.optInt(0, baseVersion)
        val remaining = JSONArray()
        for (i in 1 until prevVersions.length()) {
            remaining.put(prevVersions.optInt(i))
        }

        Log.i(TAG, "Rolling back: V${metadata.optInt("currentVersion")} → V$rollbackTo (attempt $newCount)")

        // Check if this rollback target bundle exists
        val vDir = File(otaDir, "v${rollbackTo}")
        val targetBundle = File(vDir, "index.android.bundle")
        if (!targetBundle.exists() && rollbackTo > baseVersion) {
            Log.w(TAG, "index.android.bundle not found in V$rollbackTo, trying deeper rollback...")
            val intermediate = JSONObject().apply {
                put("currentVersion", rollbackTo)
                put("previousVersions", remaining)
                put("rollbackCount", newCount)
                put("lastLaunchSuccessful", false)
            }
            return performRollback(intermediate, baseVersion, newCount, otaDir)
        }

        return JSONObject().apply {
            put("currentVersion", rollbackTo)
            put("previousVersions", remaining)
            put("rollbackCount", newCount)
            put("lastLaunchSuccessful", true) // Will be set to false again in resolve()
        }
    }

    /**
     * Resets metadata to factory defaults.
     */
    private fun resetToFactory(metadataFile: File, baseVersion: Int, old: JSONObject) {
        val factory = JSONObject().apply {
            put("currentVersion", baseVersion)
            put("previousVersions", JSONArray())
            put("rollbackCount", 0)
            put("lastLaunchSuccessful", true)
            // Keep: otherwise JS re-downloads a version that crashed on boot
            old.optJSONArray("failedVersions")?.let { put("failedVersions", it) }
            old.optString("appVersion", "").takeIf { it.isNotEmpty() }?.let { put("appVersion", it) }
        }
        writeMetadata(metadataFile, factory)
    }

    @JvmStatic
    fun markAsHealthy(context: Context) {
        try {
            val otaDir = File(context.filesDir, OTA_DIR_NAME)
            val metadataFile = File(otaDir, METADATA_FILE)
            if (!metadataFile.exists()) return

            val metadata = JSONObject(metadataFile.readText())
            // Same rule as JS markHealthy: a version installed since boot hasn't run yet, leave it pending
            val launched = launchedVersion
            if (launched != null) {
                if (metadata.optInt("currentVersion", launched) != launched) return
                metadata.put("verifiedVersion", launched)
            }
            metadata.put("lastLaunchSuccessful", true)
            metadata.put("rollbackCount", 0)

            writeMetadata(metadataFile, metadata)
            Log.i(TAG, "App marked as healthy")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to mark as healthy: ${e.message}")
        }
    }

    /**
     * Writes metadata JSON to disk.
     */
    private fun writeMetadata(file: File, metadata: JSONObject) {
        try {
            file.parentFile?.mkdirs()
            // Write-then-rename: a crash mid-write never leaves truncated JSON
            val tmp = File(file.parentFile, "${file.name}.tmp")
            tmp.writeText(metadata.toString(2))
            if (!tmp.renameTo(file)) throw java.io.IOException("rename failed")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to write metadata: ${e.message}")
        }
    }
}
