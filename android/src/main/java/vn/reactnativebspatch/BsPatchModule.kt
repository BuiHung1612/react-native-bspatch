package vn.reactnativebspatch

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.Promise
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.util.zip.ZipInputStream
import java.util.zip.GZIPInputStream


class BsPatchModule(private val reactContext: ReactApplicationContext) : NativeBsPatchSpec(reactContext) {

    companion object {
        const val NAME = "BsPatch"

        init {
            System.loadLibrary("bspatch")
        }
    }

    override fun getName(): String {
        return NAME
    }

    private external fun nativeApplyPatch(oldPath: String, newPath: String, patchPath: String): Boolean

    override fun applyPatch(oldPath: String, newPath: String, patchPath: String, promise: com.facebook.react.bridge.Promise) {
        Thread {
            try {
                val result = nativeApplyPatch(oldPath, newPath, patchPath)
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("ERR_BSPATCH", e.message, e)
            }
        }.start()
    }

    override fun unzip(source: String, targetDir: String, promise: Promise) {
        Thread {
            try {
                val sourceFile = File(source)
                val destDir = File(targetDir)
                if (!destDir.exists()) destDir.mkdirs()

                ZipInputStream(BufferedInputStream(FileInputStream(sourceFile))).use { zis ->
                    var entry = zis.nextEntry
                    while (entry != null) {
                        val file = File(destDir, entry.name)
                        if (entry.isDirectory) {
                            file.mkdirs()
                        } else {
                            file.parentFile?.mkdirs()
                            BufferedOutputStream(FileOutputStream(file)).use { bos ->
                                zis.copyTo(bos)
                            }
                        }
                        zis.closeEntry()
                        entry = zis.nextEntry
                    }
                }
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("ERR_UNZIP", e.message, e)
            }
        }.start()
    }

    /**
     * Extracts the JS bundle from APK assets using Android AssetManager.
     * Guarantees byte-exact copy — RNFS.copyFileAssets can produce different
     * bytes in certain APK configurations.
     */
    override fun extractBundleFromAssets(assetName: String, destPath: String, promise: Promise) {
        Thread {
            try {
                val assetManager = reactContext.assets
                assetManager.open(assetName).use { input ->
                    val destFile = File(destPath)
                    destFile.parentFile?.mkdirs()
                    BufferedOutputStream(FileOutputStream(destFile)).use { output ->
                        input.copyTo(output, bufferSize = 8192)
                    }
                }
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("ERR_EXTRACT_ASSET", e.message, e)
            }
        }.start()
    }

    override fun markAsHealthy() {
        OtaBundleResolver.markAsHealthy(reactContext)
    }

    override fun reloadBundle() {
        val activity = reactContext.currentActivity
        if (activity != null) {
            Handler(Looper.getMainLooper()).post {
                val intent = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
                if (intent != null) {
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    activity.startActivity(intent)
                    Runtime.getRuntime().exit(0)
                }
            }
        }
    }

    override fun logNative(message: String?) {
        android.util.Log.d("JS-OTA", message ?: "")
    }

    override fun decompressGzip(sourcePath: String, destPath: String, promise: Promise) {
        Thread {
            try {
                val source = File(sourcePath)
                val dest = File(destPath)
                dest.parentFile?.mkdirs()

                GZIPInputStream(BufferedInputStream(FileInputStream(source))).use { gis ->
                    BufferedOutputStream(FileOutputStream(dest)).use { bos ->
                        gis.copyTo(bos)
                    }
                }
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("ERR_GZIP_DECOMPRESS", e.message, e)
            }
        }.start()
    }

}
