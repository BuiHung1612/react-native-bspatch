#import "RNBsPatch.h"
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <zlib.h>
#import <CommonCrypto/CommonHMAC.h>
#import <CommonCrypto/CommonDigest.h>
#import <Security/Security.h>
#import <React/RCTLog.h>
#import <React/RCTReloadCommand.h>
#import <SSZipArchive/SSZipArchive.h>

#if __has_include(<react_native_bspatch/react_native_bspatch-Swift.h>)
#import <react_native_bspatch/react_native_bspatch-Swift.h>
#else
#import "react_native_bspatch-Swift.h"
#endif

#ifdef __cplusplus
extern "C" {
#endif
#include "../cpp/bsdiff/bspatch_wrapper.h"
#ifdef __cplusplus
}
#endif

// Import codegen headers for New Architecture
#ifdef RCT_NEW_ARCH_ENABLED
#import "RNBsPatchSpec.h"
#endif

@interface RNBsPatch () <RCTBridgeModule>
@end

@implementation RNBsPatch

RCT_EXPORT_MODULE(BsPatch)

+ (BOOL)requiresMainQueueSetup {
    return NO;
}

RCT_EXPORT_METHOD(applyPatch:(NSString *)oldPath
                  newPath:(NSString *)newPath
                  patchPath:(NSString *)patchPath
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        const char *old_file = [oldPath UTF8String];
        const char *new_file = [newPath UTF8String];
        const char *patch_file = [patchPath UTF8String];

        int result = apply_bspatch(old_file, new_file, patch_file);
        
        if (result == 0) {
            resolve(@(YES));
        } else {
            resolve(@(NO));
        }
    });
}

RCT_EXPORT_METHOD(unzip:(NSString *)source
                  targetDir:(NSString *)targetDir
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        BOOL success = [SSZipArchive unzipFileAtPath:source toDestination:targetDir];
        if (success) {
            resolve(@(YES));
        } else {
            reject(@"ERR_UNZIP", @"Failed to unzip file", nil);
        }
    });
}

RCT_EXPORT_METHOD(extractBundleFromAssets:(NSString *)assetName
                  destPath:(NSString *)destPath
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        NSString *resourceName = [assetName stringByDeletingPathExtension];
        NSString *resourceType = [assetName pathExtension];
        if (resourceType.length == 0) resourceType = @"jsbundle";
        
        NSString *bundlePath = [[NSBundle mainBundle] pathForResource:resourceName ofType:resourceType];
        if (!bundlePath) {
            reject(@"ERR_EXTRACT_ASSET", [NSString stringWithFormat:@"%@ not found in main bundle", assetName], nil);
            return;
        }
        NSError *error = nil;
        BOOL success = [[NSFileManager defaultManager] copyItemAtPath:bundlePath toPath:destPath error:&error];
        if (success) {
            resolve(@(YES));
        } else {
            reject(@"ERR_EXTRACT_ASSET", error.localizedDescription, error);
        }
    });
}

RCT_EXPORT_METHOD(reloadBundle)
{
    dispatch_async(dispatch_get_main_queue(), ^{
        RCTTriggerReloadCommandListeners(@"OTA Update Applied");
    });
}

RCT_EXPORT_METHOD(logNative:(NSString *)message)
{
    NSLog(@"[JS-OTA] %@", message);
}

RCT_EXPORT_METHOD(markAsHealthy)
{
    [OtaBundleResolver markAsHealthy];
}

RCT_EXPORT_METHOD(decompressGzip:(NSString *)sourcePath
                  destPath:(NSString *)destPath
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        NSString *src = sourcePath;
        NSString *dst = destPath;

        // Remove existing destination file if present
        [[NSFileManager defaultManager] removeItemAtPath:dst error:nil];

        // Read the compressed data
        NSData *compressed = [NSData dataWithContentsOfFile:src];
        if (!compressed) {
            reject(@"ERR_GZIP_DECOMPRESS", @"Failed to read source file", nil);
            return;
        }

        // Decompress using zlib (Compression framework handles gzip automatically)
        // COMPRESSION_ZLIB wrapper detects gzip format from the header
        NSData *decompressed = [self decompressGzipData:compressed];
        if (!decompressed) {
            reject(@"ERR_GZIP_DECOMPRESS", @"Failed to decompress gzip data", nil);
            return;
        }

        NSError *error = nil;
        BOOL success = [decompressed writeToFile:dst options:NSDataWritingAtomic error:&error];
        if (success) {
            resolve(@(YES));
        } else {
            reject(@"ERR_GZIP_DECOMPRESS", error.localizedDescription, error);
        }
    });
}

RCT_EXPORT_METHOD(verifySignature:(NSString *)filePath
                  signature:(NSString *)signature
                  publicKey:(NSString *)publicKey
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        NSString *cleanKey = [publicKey stringByReplacingOccurrencesOfString:@"-----BEGIN PUBLIC KEY-----" withString:@""];
        cleanKey = [cleanKey stringByReplacingOccurrencesOfString:@"-----END PUBLIC KEY-----" withString:@""];
        cleanKey = [cleanKey stringByReplacingOccurrencesOfString:@"-----BEGIN RSA PUBLIC KEY-----" withString:@""];
        cleanKey = [cleanKey stringByReplacingOccurrencesOfString:@"-----END RSA PUBLIC KEY-----" withString:@""];
        cleanKey = [cleanKey stringByReplacingOccurrencesOfString:@"\n" withString:@""];
        cleanKey = [cleanKey stringByReplacingOccurrencesOfString:@"\r" withString:@""];
        cleanKey = [cleanKey stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];

        NSData *keyData = [[NSData alloc] initWithBase64EncodedString:cleanKey options:NSDataBase64DecodingIgnoreUnknownCharacters];
        NSData *expectedSig = [[NSData alloc] initWithBase64EncodedString:signature options:NSDataBase64DecodingIgnoreUnknownCharacters];

        if (!keyData || !expectedSig) {
            resolve(@(NO));
            return;
        }

        // Calculate SHA256 of file stream
        NSInputStream *stream = [NSInputStream inputStreamWithFileAtPath:filePath];
        if (!stream) {
            resolve(@(NO));
            return;
        }
        [stream open];

        CC_SHA256_CTX shaCtx;
        CC_SHA256_Init(&shaCtx);
        uint8_t buffer[65536];
        while ([stream hasBytesAvailable]) {
            NSInteger bytesRead = [stream read:buffer maxLength:sizeof(buffer)];
            if (bytesRead > 0) {
                CC_SHA256_Update(&shaCtx, buffer, (CC_LONG)bytesRead);
            } else if (bytesRead < 0) {
                [stream close];
                resolve(@(NO));
                return;
            }
        }
        [stream close];

        unsigned char sha256[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256_Final(sha256, &shaCtx);
        NSData *sha256Data = [NSData dataWithBytes:sha256 length:CC_SHA256_DIGEST_LENGTH];

        // 1. Try RSA Public Key
        NSDictionary *rsaParams = @{
            (id)kSecAttrKeyType: (id)kSecAttrKeyTypeRSA,
            (id)kSecAttrKeyClass: (id)kSecAttrKeyClassPublic,
        };
        CFErrorRef rsaErr = NULL;
        SecKeyRef rsaKey = SecKeyCreateWithData((__bridge CFDataRef)keyData, (__bridge CFDictionaryRef)rsaParams, &rsaErr);
        if (rsaKey) {
            CFErrorRef verifyErr = NULL;
            Boolean isValid = SecKeyVerifySignature(
                rsaKey,
                kSecKeyAlgorithmRSASignatureDigestPKCS1v15SHA256,
                (__bridge CFDataRef)sha256Data,
                (__bridge CFDataRef)expectedSig,
                &verifyErr
            );
            CFRelease(rsaKey);
            if (!verifyErr) {
                resolve(@(isValid ? YES : NO));
                return;
            }
        }

        // 2. Try ECDSA Public Key
        NSDictionary *ecParams = @{
            (id)kSecAttrKeyType: (id)kSecAttrKeyTypeECSECPrimeRandom,
            (id)kSecAttrKeyClass: (id)kSecAttrKeyClassPublic,
        };
        CFErrorRef ecErr = NULL;
        SecKeyRef ecKey = SecKeyCreateWithData((__bridge CFDataRef)keyData, (__bridge CFDictionaryRef)ecParams, &ecErr);
        if (ecKey) {
            CFErrorRef verifyErr = NULL;
            Boolean isValid = SecKeyVerifySignature(
                ecKey,
                kSecKeyAlgorithmECDSASignatureDigestX962SHA256,
                (__bridge CFDataRef)sha256Data,
                (__bridge CFDataRef)expectedSig,
                &verifyErr
            );
            CFRelease(ecKey);
            if (!verifyErr) {
                resolve(@(isValid ? YES : NO));
                return;
            }
        }

        // 3. Fallback: HMAC-SHA256
        NSInputStream *hmacStream = [NSInputStream inputStreamWithFileAtPath:filePath];
        if (!hmacStream) {
            resolve(@(NO));
            return;
        }
        [hmacStream open];

        CCHmacContext ctx;
        CCHmacInit(&ctx, kCCHmacAlgSHA256, keyData.bytes, keyData.length);
        while ([hmacStream hasBytesAvailable]) {
            NSInteger bytesRead = [hmacStream read:buffer maxLength:sizeof(buffer)];
            if (bytesRead > 0) {
                CCHmacUpdate(&ctx, buffer, (CC_LONG)bytesRead);
            } else if (bytesRead < 0) {
                [hmacStream close];
                resolve(@(NO));
                return;
            }
        }
        [hmacStream close];

        unsigned char hmac[CC_SHA256_DIGEST_LENGTH];
        CCHmacFinal(&ctx, hmac);

        BOOL isValid = (expectedSig.length == CC_SHA256_DIGEST_LENGTH) &&
                       (memcmp(expectedSig.bytes, hmac, CC_SHA256_DIGEST_LENGTH) == 0);
        resolve(@(isValid));
    });
}

RCT_EXPORT_METHOD(getAppVersion:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    NSString *version = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    if (!version || version.length == 0) {
        reject(@"ERR_NO_VERSION", @"CFBundleShortVersionString is missing in iOS Info.plist", nil);
    } else {
        resolve(version);
    }
}

- (NSData *)decompressGzipData:(NSData *)compressed {
    // Decompress gzip using zlib directly
    // gzip adds a 10-byte header + 8-byte footer over the raw zlib stream
    const size_t chunkSize = 65536;
    z_stream strm;
    memset(&strm, 0, sizeof(strm));

    strm.next_in = (Bytef *)compressed.bytes;
    strm.avail_in = (uInt)compressed.length;

    // 16 + MAX_WBITS = automatic gzip/zlib header detection
    if (inflateInit2(&strm, 16 + MAX_WBITS) != Z_OK) {
        return nil;
    }

    NSMutableData *decompressed = [NSMutableData dataWithCapacity:compressed.length * 4];
    unsigned char out[chunkSize];
    int ret;

    do {
        strm.next_out = out;
        strm.avail_out = chunkSize;
        ret = inflate(&strm, Z_FINISH);
        if (ret != Z_STREAM_END && ret != Z_OK && ret != Z_BUF_ERROR) {
            inflateEnd(&strm);
            return nil;
        }
        size_t have = chunkSize - strm.avail_out;
        [decompressed appendBytes:out length:have];
    } while (ret != Z_STREAM_END);

    inflateEnd(&strm);
    return [decompressed copy];
}

// Don't compile this code when we build for the old architecture.
#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeBsPatchSpecJSI>(params);
}
#endif

@end
