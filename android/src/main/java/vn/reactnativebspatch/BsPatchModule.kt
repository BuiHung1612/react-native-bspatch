package vn.reactnativebspatch

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.Promise
import com.facebook.react.common.LifecycleState
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

class BsPatchModule(private val reactContext: ReactApplicationContext) : NativeBsPatchSpec(reactContext) {

    companion object {
        const val NAME = "BsPatch"
        private const val IO_BUFFER_SIZE = 65536 // 64KB buffer for optimal flash storage I/O
        private const val PROGRESS_INTERVAL_MS = 250L
        // Unbounded: JS runs up to 6 asset downloads at once next to patch/hash work
        private val backgroundExecutor = Executors.newCachedThreadPool()

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

    override fun markAsHealthy() {
        OtaBundleResolver.markAsHealthy(reactContext)
    }

    override fun reloadBundle() {
        Handler(Looper.getMainLooper()).post {
            // Backgrounded: just exit, the next launch is a cold start on the new bundle.
            // Relaunching here would pull the app back to the foreground.
            val activity = reactContext.currentActivity
            if (activity != null && reactContext.lifecycleState == LifecycleState.RESUMED) {
                val intent = activity.packageManager.getLaunchIntentForPackage(activity.packageName) ?: return@post
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
                activity.startActivity(intent)
            }
            Runtime.getRuntime().exit(0)
        }
    }

    override fun logNative(message: String?) {
        android.util.Log.d("JS-OTA", message ?: "")
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

                // Pick the algorithm from the key itself; never fall back to another scheme
                val keySpec = java.security.spec.X509EncodedKeySpec(keyBytes)
                val pubKey = try {
                    java.security.KeyFactory.getInstance("RSA").generatePublic(keySpec)
                } catch (e: Exception) {
                    java.security.KeyFactory.getInstance("EC").generatePublic(keySpec)
                }
                val sig = java.security.Signature.getInstance(
                    if (pubKey.algorithm == "RSA") "SHA256withRSA" else "SHA256withECDSA"
                )
                sig.initVerify(pubKey)

                val buffer = ByteArray(IO_BUFFER_SIZE)
                FileInputStream(file).use { fis ->
                    var read: Int
                    while (fis.read(buffer).also { read = it } != -1) {
                        sig.update(buffer, 0, read)
                    }
                }
                promise.resolve(sig.verify(expectedSigBytes))
            } catch (e: java.security.GeneralSecurityException) {
                // Malformed key/signature → invalid (fail closed)
                promise.resolve(false)
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

    // ─── File I/O ───────────────────────────────────────────────────────

    /** Runs block off the JS thread; Unit resolves as null. */
    private fun io(promise: Promise, block: () -> Any?) {
        backgroundExecutor.execute {
            try {
                val result = block()
                promise.resolve(if (result == Unit) null else result)
            } catch (e: Exception) {
                promise.reject("ERR_FS", e.message, e)
            }
        }
    }

    override fun getDocumentDir(): String = reactContext.filesDir.absolutePath

    override fun downloadFile(url: String, destPath: String, timeoutMs: Double, promise: Promise) {
        backgroundExecutor.execute {
            val part = File("$destPath.part")
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = timeoutMs.toInt()
                    readTimeout = timeoutMs.toInt()
                    instanceFollowRedirects = true
                    setRequestProperty("Cache-Control", "no-cache")
                }
                val status = conn.responseCode
                if (status !in 200..299) throw IOException("HTTP $status for $url")
                // -1 when unknown (also when the body is transparently gunzipped)
                val total = conn.contentLengthLong
                part.parentFile?.mkdirs()
                var received = 0L
                var lastEmit = 0L
                conn.inputStream.use { input ->
                    FileOutputStream(part).use { output ->
                        val buffer = ByteArray(IO_BUFFER_SIZE)
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            output.write(buffer, 0, n)
                            received += n
                            val now = SystemClock.uptimeMillis()
                            if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                                lastEmit = now
                                emitProgress(destPath, received, total)
                            }
                        }
                        output.fd.sync()
                    }
                }
                if (total >= 0 && received != total) {
                    throw IOException("Download truncated: $received of $total bytes")
                }
                emitProgress(destPath, received, total)
                if (!part.renameTo(File(destPath))) throw IOException("Rename to $destPath failed")
                promise.resolve(received.toDouble())
            } catch (e: Exception) {
                part.delete()
                promise.reject("ERR_DOWNLOAD", e.message, e)
            } finally {
                conn?.disconnect()
            }
        }
    }

    private fun emitProgress(path: String, received: Long, total: Long) {
        emitOnDownloadProgress(Arguments.createMap().apply {
            putString("path", path)
            putDouble("received", received.toDouble())
            putDouble("total", total.toDouble())
        })
    }

    override fun hashFile(path: String, promise: Promise) = io(promise) {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(IO_BUFFER_SIZE)
        FileInputStream(path).use { input ->
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        digest.digest().joinToString("") { "%02x".format(it) }
    }

    override fun exists(path: String, promise: Promise) = io(promise) { File(path).exists() }

    override fun mkdir(path: String, promise: Promise) = io(promise) {
        val dir = File(path)
        if (!dir.mkdirs() && !dir.isDirectory) throw IOException("mkdir failed: $path")
    }

    override fun removePath(path: String, promise: Promise) = io(promise) {
        val file = File(path)
        if (!file.deleteRecursively() && file.exists()) throw IOException("remove failed: $path")
    }

    override fun moveFile(from: String, to: String, promise: Promise) = io(promise) {
        val src = File(from)
        val dst = File(to)
        // rename() replaces a file atomically; a non-empty directory must go first
        if (!src.renameTo(dst)) {
            dst.deleteRecursively()
            if (!src.renameTo(dst)) throw IOException("move failed: $from → $to")
        }
    }

    override fun copyFile(from: String, to: String, promise: Promise) = io(promise) {
        File(from).copyTo(File(to), overwrite = true)
        Unit
    }

    override fun readDir(path: String, promise: Promise) = io(promise) {
        val names = File(path).list() ?: throw IOException("Not a directory: $path")
        Arguments.createArray().apply { names.forEach { pushString(it) } }
    }

    override fun readFile(path: String, promise: Promise) = io(promise) { File(path).readText() }

    override fun writeFile(path: String, content: String, promise: Promise) = io(promise) {
        // Write-then-rename: a kill mid-write never leaves a truncated file
        val file = File(path)
        val tmp = File("$path.tmp")
        tmp.writeText(content)
        if (!tmp.renameTo(file)) throw IOException("rename failed: $path")
    }
}
