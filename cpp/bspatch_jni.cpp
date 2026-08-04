#ifdef __ANDROID__
#include <jni.h>
#include <string>
extern "C" {
#include "bsdiff/bspatch_wrapper.h"
}
#include <android/log.h>

#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "bspatch", __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "bspatch", __VA_ARGS__)

extern "C" JNIEXPORT jboolean JNICALL
Java_vn_reactnativebspatch_BsPatchModule_nativeApplyPatch(
        JNIEnv* env,
        jobject /* this */,
        jstring oldPath,
        jstring newPath,
        jstring patchPath) {

    const char *old_file = env->GetStringUTFChars(oldPath, 0);
    const char *new_file = env->GetStringUTFChars(newPath, 0);
    const char *patch_file = env->GetStringUTFChars(patchPath, 0);

    LOGI("Applying patch: old=%s, new=%s, patch=%s", old_file, new_file, patch_file);

    // Call the C wrapper
    int result = apply_bspatch(old_file, new_file, patch_file);

    LOGI("apply_bspatch result = %d", result);

    env->ReleaseStringUTFChars(oldPath, old_file);
    env->ReleaseStringUTFChars(newPath, new_file);
    env->ReleaseStringUTFChars(patchPath, patch_file);

    if (result != 0) {
        LOGE("apply_bspatch failed with code %d", result);
    }

    return (result == 0) ? JNI_TRUE : JNI_FALSE;
}
#endif
