import Foundation

/**
 * OtaBundleResolver — encapsulates OTA bundle path resolution for iOS with
 * crash detection and automatic rollback.
 *
 * IMPORTANT: This runs BEFORE any JS code. If the OTA bundle is corrupted,
 * Hermes crashes before React Native boots. This native resolver handles
 * crash detection so the app can recover without JS ever running.
 *
 * Lifecycle:
 *   1. Read metadata.json
 *   2. If lastLaunchSuccessful == false → rollback to previous version
 *   3. Mark current launch as pending (lastLaunchSuccessful = false)
 *   4. Return the bundle path (or nil for IPA default)
 *   5. JS calls markAsHealthy() → sets lastLaunchSuccessful = true
 *   6. If crash before markAsHealthy → next boot sees false → rollback
 *
 * Usage in AppDelegate.swift:
 * ```swift
 * override func bundleURL() -> URL? {
 *     if let otaBundle = OtaBundleResolver.resolve() {
 *         return otaBundle
 *     }
 *     // Default RCTBundleURLProvider ...
 * }
 * ```
 */
@objcMembers
public class OtaBundleResolver: NSObject {

    private static let otaDirName = "ota"
    private static let metadataFile = "metadata.json"
    public static let defaultBaseVersion = 1
    private static let maxRollback = 3
    private static let maxRollbackIterations = 10 // Safety limit to prevent infinite loops

    /// Resolves the JS bundle path from OTA metadata.
    /// Handles crash detection and rollback entirely on the native side.
    ///
    /// - Parameter baseVersion: The OTA version baked into the IPA (default: 1)
    /// - Returns: URL to the OTA bundle, or nil to use the IPA default.
    @objc public static func resolve(baseVersion: Int = defaultBaseVersion) -> URL? {
        guard let documentsDir = FileManager.default.urls(
            for: .documentDirectory,
            in: .userDomainMask
        ).first else {
            return nil
        }

        let otaDir = documentsDir.appendingPathComponent(otaDirName)
        let metadataURL = otaDir.appendingPathComponent(metadataFile)

        guard FileManager.default.fileExists(atPath: metadataURL.path) else {
            NSLog("[OtaBundleResolver] No OTA metadata → IPA bundle")
            return nil
        }

        do {
            let data = try Data(contentsOf: metadataURL)
            guard var metadata = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return nil
            }

            let currentVersion = metadata["currentVersion"] as? Int ?? baseVersion
            let lastLaunchOk = metadata["lastLaunchSuccessful"] as? Bool ?? true
            let rollbackCount = metadata["rollbackCount"] as? Int ?? 0

            // ── Step 1: Crash detection & rollback ──────────────────────────
            if !lastLaunchOk && currentVersion > baseVersion {
                NSLog("[OtaBundleResolver] Previous launch failed! Rolling back from V\(currentVersion)...")
                
                metadata = performRollback(metadata: metadata, baseVersion: baseVersion, currentRollbackCount: rollbackCount, otaDir: otaDir)
                writeMetadata(url: metadataURL, metadata: metadata)

                let newVersion = metadata["currentVersion"] as? Int ?? baseVersion
                if newVersion <= baseVersion {
                    NSLog("[OtaBundleResolver] Rolled back to factory IPA bundle")
                    return nil
                }

                let rollbackVDir = otaDir.appendingPathComponent("v\(newVersion)")
                let rollbackBundle = rollbackVDir.appendingPathComponent("main.jsbundle")
                if !FileManager.default.fileExists(atPath: rollbackBundle.path) {
                    NSLog("[OtaBundleResolver] Rollback target main.jsbundle missing in V\(newVersion) → factory")
                    resetToFactory(url: metadataURL, baseVersion: baseVersion)
                    return nil
                }

                // Mark this rollback attempt as pending
                metadata["lastLaunchSuccessful"] = false
                writeMetadata(url: metadataURL, metadata: metadata)

                NSLog("[OtaBundleResolver] Trying rollback bundle: \(rollbackBundle.path)")
                return rollbackBundle
            }

            // ── Step 2: Normal boot — no OTA bundle needed ──────────────────
            if currentVersion <= baseVersion {
                NSLog("[OtaBundleResolver] OTA v\(currentVersion) ≤ base v\(baseVersion) → IPA bundle")
                return nil
            }

            // ── Step 3: OTA bundle — mark as pending verification ───────────
            let vDir = otaDir.appendingPathComponent("v\(currentVersion)")
            let bundleURL = vDir.appendingPathComponent("main.jsbundle")
            if !FileManager.default.fileExists(atPath: bundleURL.path) {
                NSLog("[OtaBundleResolver] main.jsbundle missing in V\(currentVersion) → IPA bundle")
                resetToFactory(url: metadataURL, baseVersion: baseVersion)
                return nil
            }

            // Mark launch as pending
            metadata["lastLaunchSuccessful"] = false
            writeMetadata(url: metadataURL, metadata: metadata)

            NSLog("[OtaBundleResolver] Loading OTA bundle: \(bundleURL.path)")
            return bundleURL

        } catch {
            NSLog("[OtaBundleResolver] Error: \(error.localizedDescription)")
            return nil
        }
    }

    private static func performRollback(metadata: [String: Any], baseVersion: Int, currentRollbackCount: Int, otaDir: URL) -> [String: Any] {
        var rollbackCount = currentRollbackCount + 1
        var prevVersions = metadata["previousVersions"] as? [Int] ?? []
        var current = metadata
        var iteration = 0

        while iteration < maxRollbackIterations {
            iteration += 1

            if rollbackCount >= maxRollback {
                NSLog("[OtaBundleResolver] Max rollback (\(maxRollback)) reached → factory reset")
                return [
                    "currentVersion": baseVersion,
                    "previousVersions": [Int](),
                    "rollbackCount": 0,
                    "lastLaunchSuccessful": true
                ]
            }

            guard !prevVersions.isEmpty else {
                NSLog("[OtaBundleResolver] No previous versions to rollback to → factory reset")
                return [
                    "currentVersion": baseVersion,
                    "previousVersions": [Int](),
                    "rollbackCount": rollbackCount,
                    "lastLaunchSuccessful": true
                ]
            }

            let rollbackTo = prevVersions[0]
            prevVersions = Array(prevVersions.dropFirst())

            NSLog("[OtaBundleResolver] Rolling back: V\(current["currentVersion"] as? Int ?? baseVersion) → V\(rollbackTo) (attempt \(rollbackCount))")

            let vDir = otaDir.appendingPathComponent("v\(rollbackTo)")
            let targetBundle = vDir.appendingPathComponent("main.jsbundle")
            if !FileManager.default.fileExists(atPath: targetBundle.path) && rollbackTo > baseVersion {
                NSLog("[OtaBundleResolver] main.jsbundle not found in V\(rollbackTo), trying deeper rollback...")
                current = [
                    "currentVersion": rollbackTo,
                    "previousVersions": prevVersions,
                    "rollbackCount": rollbackCount,
                    "lastLaunchSuccessful": false
                ]
                rollbackCount += 1
                continue
            }

            return [
                "currentVersion": rollbackTo,
                "previousVersions": prevVersions,
                "rollbackCount": rollbackCount,
                "lastLaunchSuccessful": true
            ]
        }

        // Safety: if we somehow exit the loop without returning, do factory reset
        NSLog("[OtaBundleResolver] Max rollback iterations (\(maxRollbackIterations)) exceeded → factory reset")
        return [
            "currentVersion": baseVersion,
            "previousVersions": [Int](),
            "rollbackCount": 0,
            "lastLaunchSuccessful": true
        ]
    }

    private static func resetToFactory(url: URL, baseVersion: Int) {
        let factory: [String: Any] = [
            "currentVersion": baseVersion,
            "previousVersions": [Int](),
            "rollbackCount": 0,
            "lastLaunchSuccessful": true
        ]
        writeMetadata(url: url, metadata: factory)
    }

    @objc public static func markAsHealthy() {
        guard let documentsDir = FileManager.default.urls(
            for: .documentDirectory, 
            in: .userDomainMask
        ).first else {
            return
        }

        let otaDir = documentsDir.appendingPathComponent(otaDirName)
        let metadataURL = otaDir.appendingPathComponent(metadataFile)

        guard FileManager.default.fileExists(atPath: metadataURL.path) else {
            return
        }

        do {
            let data = try Data(contentsOf: metadataURL)
            guard var metadata = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return
            }

            metadata["lastLaunchSuccessful"] = true
            metadata["rollbackCount"] = 0
            
            writeMetadata(url: metadataURL, metadata: metadata)
            NSLog("[OtaBundleResolver] App marked as healthy")
        } catch {
            NSLog("[OtaBundleResolver] Failed to mark as healthy: \(error.localizedDescription)")
        }
    }

    private static func writeMetadata(url: URL, metadata: [String: Any]) {
        do {
            let data = try JSONSerialization.data(withJSONObject: metadata, options: .prettyPrinted)
            try data.write(to: url)
        } catch {
            NSLog("[OtaBundleResolver] Failed to write metadata: \(error.localizedDescription)")
        }
    }
}
