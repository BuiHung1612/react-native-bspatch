#import "RNBsPatch.h"
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonDigest.h>
#import <Security/Security.h>
#import <React/RCTLog.h>
#import <React/RCTReloadCommand.h>

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

// Reads one DER TLV at *pos; returns content range and advances *pos past it.
static BOOL RNBsPatchReadDER(const uint8_t *b, NSUInteger len, NSUInteger *pos, uint8_t *tag, NSRange *content)
{
    if (*pos + 2 > len) return NO;
    *tag = b[(*pos)++];
    NSUInteger l = b[(*pos)++];
    if (l & 0x80) {
        NSUInteger n = l & 0x7f;
        if (n == 0 || n > 4 || *pos + n > len) return NO;
        l = 0;
        for (NSUInteger i = 0; i < n; i++) l = (l << 8) | b[(*pos)++];
    }
    if (l > len - *pos) return NO;
    *content = NSMakeRange(*pos, l);
    *pos += l;
    return YES;
}

// SubjectPublicKeyInfo (PEM "PUBLIC KEY") → raw key bytes SecKeyCreateWithData accepts
// (PKCS#1 for RSA, X9.63 point for EC). Returns nil if not a valid SPKI.
static NSData *RNBsPatchKeyFromSPKI(NSData *spki, BOOL *isRSA)
{
    static const uint8_t rsaOID[] = {0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01};
    static const uint8_t ecOID[] = {0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01};
    const uint8_t *b = (const uint8_t *)spki.bytes;
    NSUInteger len = spki.length, pos = 0, inner;
    uint8_t tag;
    NSRange outer, algo, oid, bits;
    if (!RNBsPatchReadDER(b, len, &pos, &tag, &outer) || tag != 0x30) return nil;
    pos = outer.location;
    if (!RNBsPatchReadDER(b, len, &pos, &tag, &algo) || tag != 0x30) return nil;
    if (!RNBsPatchReadDER(b, len, &pos, &tag, &bits) || tag != 0x03 || bits.length < 2 || b[bits.location] != 0) return nil;
    inner = algo.location;
    if (!RNBsPatchReadDER(b, len, &inner, &tag, &oid) || tag != 0x06) return nil;
    if (oid.length == sizeof(rsaOID) && memcmp(b + oid.location, rsaOID, sizeof(rsaOID)) == 0) {
        *isRSA = YES;
    } else if (oid.length == sizeof(ecOID) && memcmp(b + oid.location, ecOID, sizeof(ecOID)) == 0) {
        *isRSA = NO;
    } else {
        return nil;
    }
    return [spki subdataWithRange:NSMakeRange(bits.location + 1, bits.length - 1)];
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

        BOOL isRSA = NO;
        NSData *rawKey = RNBsPatchKeyFromSPKI(keyData, &isRSA);
        if (!rawKey) {
            resolve(@(NO));
            return;
        }
        NSDictionary *params = @{
            (id)kSecAttrKeyType: isRSA ? (id)kSecAttrKeyTypeRSA : (id)kSecAttrKeyTypeECSECPrimeRandom,
            (id)kSecAttrKeyClass: (id)kSecAttrKeyClassPublic,
        };
        SecKeyRef key = SecKeyCreateWithData((__bridge CFDataRef)rawKey, (__bridge CFDictionaryRef)params, NULL);
        if (!key) {
            resolve(@(NO));
            return;
        }
        // Fail closed: any verification error counts as an invalid signature
        Boolean isValid = SecKeyVerifySignature(
            key,
            isRSA ? kSecKeyAlgorithmRSASignatureDigestPKCS1v15SHA256 : kSecKeyAlgorithmECDSASignatureDigestX962SHA256,
            (__bridge CFDataRef)sha256Data,
            (__bridge CFDataRef)expectedSig,
            NULL
        );
        CFRelease(key);
        resolve(@(isValid ? YES : NO));
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

// Don't compile this code when we build for the old architecture.
#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeBsPatchSpecJSI>(params);
}
#endif

@end
