#import <Foundation/Foundation.h>
#import <Network/Network.h>
#import <QuartzCore/QuartzCore.h>
#import <CommonCrypto/CommonDigest.h>
#import <Security/Security.h>
#import <React/RCTLog.h>
#import <React/RCTReloadCommand.h>
#include <zlib.h>

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

#import "RNBsPatchSpec.h"

// Declared here, not in a public header: the codegen header is C++, which the
// pod's Swift module umbrella can't import
@interface RNBsPatch : NativeBsPatchSpecBase <NativeBsPatchSpec>
@end

/** One download: streams to a system temp file, moved to destPath only on a 2xx response. */
@interface RNBsPatchDownload : NSObject <NSURLSessionDownloadDelegate>
@property (nonatomic, copy) NSString *destPath;
/** Where a failed attempt leaves NSURLSession resume data for the next call */
@property (nonatomic, copy) NSString *resumePath;
/** Saved with the resume data: resuming it for another URL would finish the old file */
@property (nonatomic, copy) NSString *url;
@property (nonatomic, copy) RCTPromiseResolveBlock resolve;
@property (nonatomic, copy) RCTPromiseRejectBlock reject;
@property (nonatomic, copy) void (^onProgress)(int64_t received, int64_t total);
@property (nonatomic, strong) NSError *error;
@property (nonatomic) unsigned long long size;
@property (nonatomic) CFTimeInterval lastEmit;
@end

@implementation RNBsPatchDownload

- (void)URLSession:(NSURLSession *)session
      downloadTask:(NSURLSessionDownloadTask *)task
      didWriteData:(int64_t)bytesWritten
 totalBytesWritten:(int64_t)written
totalBytesExpectedToWrite:(int64_t)expected
{
    CFTimeInterval now = CACurrentMediaTime();
    if (now - self.lastEmit < 0.25) return;
    self.lastEmit = now;
    // written counts decoded bytes, expected the Content-Length on the wire: with a
    // Content-Encoding they don't compare, so report the total as unknown like Android
    NSString *encoding = [(NSHTTPURLResponse *)task.response valueForHTTPHeaderField:@"Content-Encoding"];
    if (encoding.length > 0 && ![encoding isEqualToString:@"identity"]) expected = -1;
    self.onProgress(written, expected); // expected is -1 without a Content-Length
}

// The temp file is deleted when this returns, so move it here
- (void)URLSession:(NSURLSession *)session
      downloadTask:(NSURLSessionDownloadTask *)task
didFinishDownloadingToURL:(NSURL *)location
{
    NSInteger status = [(NSHTTPURLResponse *)task.response statusCode];
    if (status < 200 || status >= 300) {
        self.error = [NSError errorWithDomain:@"RNBsPatch" code:status userInfo:@{
            NSLocalizedDescriptionKey: [NSString stringWithFormat:@"HTTP %ld for %@", (long)status, task.originalRequest.URL]
        }];
        return;
    }
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *dir = self.destPath.stringByDeletingLastPathComponent;
    NSError *error = nil;
    [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    [fm removeItemAtPath:self.destPath error:nil];
    if (![fm moveItemAtPath:location.path toPath:self.destPath error:&error]) {
        self.error = error;
        return;
    }
    self.size = [[fm attributesOfItemAtPath:self.destPath error:nil] fileSize];
    self.onProgress((int64_t)self.size, (int64_t)self.size);
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error
{
    NSError *e = error ?: self.error;
    NSData *resumeData = error.userInfo[NSURLSessionDownloadTaskResumeData];
    if (resumeData) {
        [@{@"url": self.url, @"data": resumeData} writeToFile:self.resumePath atomically:YES];
    }
    if (e) {
        self.reject(@"ERR_DOWNLOAD", e.localizedDescription, e);
    } else {
        self.resolve(@(self.size));
    }
    [session finishTasksAndInvalidate]; // releases this delegate
}

@end

/** Streaming SHA-256 of a file, or nil if it can't be read. */
static NSData *RNBsPatchSHA256(NSString *path)
{
    NSInputStream *stream = [NSInputStream inputStreamWithFileAtPath:path];
    if (!stream) return nil;
    [stream open];
    CC_SHA256_CTX ctx;
    CC_SHA256_Init(&ctx);
    uint8_t buffer[65536];
    NSInteger n;
    while ((n = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
        CC_SHA256_Update(&ctx, buffer, (CC_LONG)n);
    }
    [stream close];
    if (n < 0) return nil;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &ctx);
    return [NSData dataWithBytes:digest length:sizeof(digest)];
}

/** Gunzips src into dst; NO on unreadable, non-gzip or truncated input. */
static BOOL RNBsPatchGunzip(NSString *src, NSString *dst)
{
    gzFile in = gzopen(src.fileSystemRepresentation, "rb");
    if (!in) return NO;
    FILE *out = fopen(dst.fileSystemRepresentation, "wb");
    if (!out) {
        gzclose(in);
        return NO;
    }
    char buffer[65536];
    int n;
    BOOL ok = YES;
    long long total = 0;
    while ((n = gzread(in, buffer, sizeof(buffer))) > 0) {
        // gzdirect: zlib copies non-gzip input through as-is
        if (gzdirect(in) || fwrite(buffer, 1, n, out) != (size_t)n) {
            ok = NO;
            break;
        }
        total += n;
    }
    // An empty source never enters the loop: no output is a failure too, like Android
    if (n < 0 || total == 0 || gzdirect(in)) ok = NO;
    if (gzclose_r(in) != Z_OK) ok = NO; // Z_BUF_ERROR: input ended mid-stream
    if (fclose(out) != 0) ok = NO;
    return ok;
}

/** Runs block off the JS thread: resolves *result, or rejects with *error when it returns NO. */
static void RNBsPatchIO(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject, BOOL (^block)(id *result, NSError **error))
{
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        id result = nil;
        NSError *error = nil;
        if (block(&result, &error)) {
            resolve(result);
        } else {
            reject(@"ERR_FS", error.localizedDescription ?: @"File operation failed", error);
        }
    });
}

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

RCT_EXPORT_METHOD(decompressFile:(NSString *)srcPath
                  destPath:(NSString *)destPath
                  format:(NSString *)format
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    RNBsPatchIO(resolve, reject, ^BOOL(id *result, NSError **error) {
        NSString *part = [destPath stringByAppendingString:@".part"];
        BOOL ok;
        if ([format isEqualToString:@"gzip"]) {
            ok = RNBsPatchGunzip(srcPath, part);
        } else if ([format isEqualToString:@"bz2"]) {
            ok = decompress_bz2(srcPath.fileSystemRepresentation, part.fileSystemRepresentation) == 0;
        } else {
            *error = [NSError errorWithDomain:@"RNBsPatch" code:1 userInfo:@{NSLocalizedDescriptionKey: [@"Unknown compression format: " stringByAppendingString:format]}];
            return NO;
        }
        if (ok) ok = rename(part.fileSystemRepresentation, destPath.fileSystemRepresentation) == 0;
        if (!ok) {
            NSFileManager *fm = NSFileManager.defaultManager;
            [fm removeItemAtPath:part error:nil];
            [fm removeItemAtPath:destPath error:nil];
            *error = [NSError errorWithDomain:@"RNBsPatch" code:2 userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Corrupt or unreadable %@ file: %@", format, srcPath]}];
        }
        return ok;
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

        NSData *sha256Data = RNBsPatchSHA256(filePath);
        if (!sha256Data) {
            resolve(@(NO));
            return;
        }

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

// ─── File I/O ─────────────────────────────────────────────────────────

- (NSString *)getDocumentDir
{
    return NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
}

- (NSString *)getEmbeddedPublicKeys
{
    id keys = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"BsPatchPublicKey"];
    return [keys isKindOfClass:[NSString class]] ? keys : @"";
}

// Shared with the resolver's Step 0 so JS stamps exactly what native compares
- (NSString *)getAppBuild
{
    return [OtaBundleResolver appBuild];
}

- (NSString *)getRuntimeFingerprint
{
    return [OtaBundleResolver runtimeFingerprint];
}

- (void)getFreeDiskSpace:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    RNBsPatchIO(resolve, reject, ^BOOL(id *result, NSError **error) {
        NSString *dir = [self getDocumentDir];
        NSNumber *free = nil;
        [[NSURL fileURLWithPath:dir] getResourceValue:&free forKey:NSURLVolumeAvailableCapacityForImportantUsageKey error:nil];
        if (free.longLongValue <= 0) {
            free = [NSFileManager.defaultManager attributesOfFileSystemForPath:dir error:error][NSFileSystemFreeSize];
        }
        *result = free;
        return free != nil;
    });
}

- (void)getNetworkType:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    nw_path_monitor_t monitor = nw_path_monitor_create();
    nw_path_monitor_set_queue(monitor, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    __block BOOL done = NO;
    // The first update is the current path; cancelling releases the handler (and the monitor)
    nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
        if (done) return;
        done = YES;
        NSString *type = @"unknown";
        if (nw_path_get_status(path) != nw_path_status_satisfied) {
            type = @"none";
        } else if (nw_path_uses_interface_type(path, nw_interface_type_wifi)) {
            type = @"wifi";
        } else if (nw_path_uses_interface_type(path, nw_interface_type_cellular)) {
            type = @"cellular";
        } else if (nw_path_uses_interface_type(path, nw_interface_type_wired)) {
            type = @"ethernet";
        }
        resolve(type);
        nw_path_monitor_cancel(monitor);
    });
    nw_path_monitor_start(monitor);
}

- (void)downloadFile:(NSString *)url
            destPath:(NSString *)destPath
           timeoutMs:(double)timeoutMs
         headersJson:(NSString *)headersJson
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
    NSURL *nsurl = [NSURL URLWithString:url];
    if (!nsurl) {
        reject(@"ERR_DOWNLOAD", [NSString stringWithFormat:@"Invalid URL: %@", url], nil);
        return;
    }
    id headers = [NSJSONSerialization JSONObjectWithData:[headersJson dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![headers isKindOfClass:[NSDictionary class]]) {
        reject(@"ERR_DOWNLOAD", [@"headersJson must be a JSON object, got: " stringByAppendingString:headersJson], nil);
        return;
    }
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:nsurl];
    for (NSString *name in headers) {
        [request setValue:[headers[name] description] forHTTPHeaderField:name];
    }
    RNBsPatchDownload *download = [RNBsPatchDownload new];
    download.destPath = destPath;
    download.resumePath = [destPath stringByAppendingString:@".resumedata"];
    download.url = url;
    download.resolve = resolve;
    download.reject = reject;
    __weak RNBsPatch *weakSelf = self;
    download.onProgress = ^(int64_t received, int64_t total) {
        [weakSelf emitOnDownloadProgress:@{@"path": destPath, @"received": @(received), @"total": @(total)}];
    };

    NSURLSessionConfiguration *config = NSURLSessionConfiguration.defaultSessionConfiguration;
    config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    config.timeoutIntervalForRequest = timeoutMs / 1000.0; // idle timeout, same as Android readTimeout
    NSURLSession *session = [NSURLSession sessionWithConfiguration:config delegate:download delegateQueue:nil];
    // Single use: a failed attempt writes fresh resume data, invalid data fails this
    // attempt and the next one starts over
    NSDictionary *saved = [NSDictionary dictionaryWithContentsOfFile:download.resumePath];
    [NSFileManager.defaultManager removeItemAtPath:download.resumePath error:nil];
    id resumeData = [saved[@"url"] isEqual:url] ? saved[@"data"] : nil;
    if (![resumeData isKindOfClass:[NSData class]]) resumeData = nil;
    NSURLSessionDownloadTask *task = resumeData ? [session downloadTaskWithResumeData:resumeData] : nil;
    [task ?: [session downloadTaskWithRequest:request] resume];
}

- (void)hashFile:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    RNBsPatchIO(resolve, reject, ^BOOL(id *result, NSError **error) {
        NSData *digest = RNBsPatchSHA256(path);
        if (!digest) {
            *error = [NSError errorWithDomain:@"RNBsPatch" code:1 userInfo:@{NSLocalizedDescriptionKey: [@"Cannot read " stringByAppendingString:path]}];
            return NO;
        }
        const uint8_t *b = (const uint8_t *)digest.bytes;
        NSMutableString *hex = [NSMutableString stringWithCapacity:digest.length * 2];
        for (NSUInteger i = 0; i < digest.length; i++) [hex appendFormat:@"%02x", b[i]];
        *result = hex;
        return YES;
    });
}

- (void)exists:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    RNBsPatchIO(resolve, reject, ^BOOL(id *result, NSError **error) {
        *result = @([NSFileManager.defaultManager fileExistsAtPath:path]);
        return YES;
    });
}

- (void)mkdir:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    RNBsPatchIO(resolve, reject, ^BOOL(id *result, NSError **error) {
        return [NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:nil error:error];
    });
}

- (void)removePath:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    RNBsPatchIO(resolve, reject, ^BOOL(id *result, NSError **error) {
        NSFileManager *fm = NSFileManager.defaultManager;
        return ![fm fileExistsAtPath:path] || [fm removeItemAtPath:path error:error];
    });
}

- (void)moveFile:(NSString *)from to:(NSString *)to resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    RNBsPatchIO(resolve, reject, ^BOOL(id *result, NSError **error) {
        // rename() replaces a file atomically; a non-empty directory must go first
        if (rename(from.fileSystemRepresentation, to.fileSystemRepresentation) == 0) return YES;
        NSFileManager *fm = NSFileManager.defaultManager;
        // A missing source fails below without costing the destination
        if ([fm fileExistsAtPath:from]) [fm removeItemAtPath:to error:nil];
        return [fm moveItemAtPath:from toPath:to error:error];
    });
}

- (void)copyFile:(NSString *)from to:(NSString *)to resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    RNBsPatchIO(resolve, reject, ^BOOL(id *result, NSError **error) {
        NSFileManager *fm = NSFileManager.defaultManager;
        [fm removeItemAtPath:to error:nil];
        return [fm copyItemAtPath:from toPath:to error:error];
    });
}

- (void)readDir:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    RNBsPatchIO(resolve, reject, ^BOOL(id *result, NSError **error) {
        *result = [NSFileManager.defaultManager contentsOfDirectoryAtPath:path error:error];
        return *result != nil;
    });
}

- (void)readFile:(NSString *)path resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    RNBsPatchIO(resolve, reject, ^BOOL(id *result, NSError **error) {
        *result = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:error];
        return *result != nil;
    });
}

- (void)writeFile:(NSString *)path content:(NSString *)content resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    RNBsPatchIO(resolve, reject, ^BOOL(id *result, NSError **error) {
        // atomically: temp file + rename, a kill mid-write never leaves a truncated file
        return [content writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:error];
    });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeBsPatchSpecJSI>(params);
}

@end
