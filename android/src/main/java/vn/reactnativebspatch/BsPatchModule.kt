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
import java.util.concurrent.Executors

class BsPatchModule(private val reactContext: ReactApplicationContext) : NativeBsPatchSpec(reactContext) {

    companion object {
        const val NAME = "BsPatch"
        private const val IO_BUFFER_SIZE = 65536 // 64KB buffer for optimal flash storage I/O
        private val backgroundExecutor = Executors.newFixedThreadPool(2)

        init {
            System.loadLibrary("bspatch")
        }
    }

    override fun getName(): String {
        return NAME
    }

    private external fun nativeApplyPatch(oldPath: String, newPath: String, patchPath: String): Boolean

    override fun applyPatch(oldPath: String, newPath: String, patchPath: String, promise: com.facebook.react.bridge.Promise) {
        backgroundExecutor.execute {
            try {
                val result = nativeApplyPatch(oldPath, newPath, patchPath)
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("ERR_BSPATCH", e.message, e)
            }
        }
    }

    override fun unzip(source: String, targetDir: String, promise: Promise) {
        backgroundExecutor.execute {
            try {
                val sourceFile = File(source)
                val destDir = File(targetDir)
                if (!destDir.exists()) destDir.mkdirs()

                ZipInputStream(BufferedInputStream(FileInputStream(sourceFile), IO_BUFFER_SIZE)).use { zis ->
                    var entry = zis.nextEntry
                    while (entry != null) {
                        val file = File(destDir, entry.name)
                        if (entry.isDirectory) {
                            file.mkdirs()
                        } else {
                            file.parentFile?.mkdirs()
                            BufferedOutputStream(FileOutputStream(file), IO_BUFFER_SIZE).use { bos ->
                                zis.copyTo(bos, bufferSize = IO_BUFFER_SIZE)
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
        }
    }

    /**
     * Extracts the JS bundle from APK assets using Android AssetManager.
     * Guarantees byte-exact copy — RNFS.copyFileAssets can produce different
     * bytes in certain APK configurations.
     */
    override fun extractBundleFromAssets(assetName: String, destPath: String, promise: Promise) {
        backgroundExecutor.execute {
            try {
                val assetManager = reactContext.assets
                assetManager.open(assetName).use { input ->
                    val destFile = File(destPath)
                    destFile.parentFile?.mkdirs()
                    BufferedOutputStream(FileOutputStream(destFile), IO_BUFFER_SIZE).use { output ->
                        input.copyTo(output, bufferSize = IO_BUFFER_SIZE)
                    }
                }
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("ERR_EXTRACT_ASSET", e.message, e)
            }
        }
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
        backgroundExecutor.execute {
            try {
                val source = File(sourcePath)
                val dest = File(destPath)
                dest.parentFile?.mkdirs()

                GZIPInputStream(BufferedInputStream(FileInputStream(source), IO_BUFFER_SIZE), IO_BUFFER_SIZE).use { gis ->
                    BufferedOutputStream(FileOutputStream(dest), IO_BUFFER_SIZE).use { bos ->
                        gis.copyTo(bos, bufferSize = IO_BUFFER_SIZE)
                    }
                }
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("ERR_GZIP_DECOMPRESS", e.message, e)
            }
        }
    }

    override fun verifySignature(filePath: String, signature: String, publicKey: String, promise: Promise) {
        backgroundExecutor.execute {
            try {
                val file = File(filePath)
                if (!file.exists()) {
                    promise.resolve(false)
                    return@execute
                }

                val cleanKey = publicKey
                    .replace("-----BEGIN PUBLIC KEY-----", "")
                    .replace("-----END PUBLIC KEY-----", "")
                    .replace("-----BEGIN RSA PUBLIC KEY-----", "")
                    .replace("-----END RSA PUBLIC KEY-----", "")
                    .replace("\\s".toRegex(), "")

                val keyBytes = android.util.Base64.decode(cleanKey, android.util.Base64.DEFAULT)
                val expectedSigBytes = android.util.Base64.decode(signature.trim(), android.util.Base64.DEFAULT)

                // 1. Try RSA Public Key (SHA256withRSA)
                try {
                    val keySpec = java.security.spec.X509EncodedKeySpec(keyBytes)
                    val keyFactory = java.security.KeyFactory.getInstance("RSA")
                    val pubKey = keyFactory.generatePublic(keySpec)
                    val sig = java.security.Signature.getInstance("SHA256withRSA")
                    sig.initVerify(pubKey)

                    val buffer = ByteArray(IO_BUFFER_SIZE)
                    FileInputStream(file).use { fis ->
                        var read: Int
                        while (fis.read(buffer).also { read = it } != -1) {
                            sig.update(buffer, 0, read)
                        }
                    }
                    val isValid = sig.verify(expectedSigBytes)
                    promise.resolve(isValid)
                    return@execute
                } catch (rsaEx: Exception) {
                    // Not RSA, continue
                }

                // 2. Try ECDSA Public Key (SHA256withECDSA)
                try {
                    val keySpec = java.security.spec.X509EncodedKeySpec(keyBytes)
                    val keyFactory = java.security.KeyFactory.getInstance("EC")
                    val pubKey = keyFactory.generatePublic(keySpec)
                    val sig = java.security.Signature.getInstance("SHA256withECDSA")
                    sig.initVerify(pubKey)

                    val buffer = ByteArray(IO_BUFFER_SIZE)
                    FileInputStream(file).use { fis ->
                        var read: Int
                        while (fis.read(buffer).also { read = it } != -1) {
                            sig.update(buffer, 0, read)
                        }
                    }
                    val isValid = sig.verify(expectedSigBytes)
                    promise.resolve(isValid)
                    return@execute
                } catch (ecEx: Exception) {
                    // Not EC, continue
                }

                // 3. Fallback: HMAC-SHA256
                val mac = javax.crypto.Mac.getInstance("HmacSHA256")
                val secretKey = javax.crypto.spec.SecretKeySpec(keyBytes, "HmacSHA256")
                mac.init(secretKey)

                val buffer = ByteArray(IO_BUFFER_SIZE)
                FileInputStream(file).use { fis ->
                    var read: Int
                    while (fis.read(buffer).also { read = it } != -1) {
                        mac.update(buffer, 0, read)
                    }
                }
                val computedSigBytes = mac.doFinal()
                val isValid = java.security.MessageDigest.isEqual(expectedSigBytes, computedSigBytes)
                promise.resolve(isValid)
            } catch (e: Exception) {
                promise.reject("ERR_VERIFY_SIG", e.message, e)
            }
        }
    }

    override fun getAppVersion(promise: Promise) {
        try {
            val pInfo = reactContext.packageManager.getPackageInfo(reactContext.packageName, 0)
            val versionName = pInfo.versionName
            if (versionName.isNullOrEmpty()) {
                promise.reject("ERR_NO_VERSION", "PackageInfo.versionName is null or empty in AndroidManifest.xml")
            } else {
                promise.resolve(versionName)
            }
        } catch (e: Exception) {
            promise.reject("ERR_GET_APP_VERSION", "Failed to get Android app version: ${e.message}", e)
        }
    }

}
