import Darwin
import Foundation
import QwenInputCore
import Security

final class SystemInputMethodFileSystem: InputMethodLifecycleFileSystem {
    private var backupURLs: [String: URL] = [:]
    private let signatureValidator: CodeSignatureValidator

    init(requirement: PeerCodeSigningRequirement) {
        signatureValidator = CodeSignatureValidator(requirement: requirement)
    }

    func inspect(at url: URL) -> InputMethodArtifactInspection? {
        var information = stat()
        guard lstat(url.path, &information) == 0 else { return nil }
        let symbolicLink = information.st_mode & S_IFMT == S_IFLNK
        guard let bundle = Bundle(url: url),
              let bundleID = bundle.bundleIdentifier,
              let version = bundle.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
              ) as? String else { return nil }
        return InputMethodArtifactInspection(
            symbolicLink: symbolicLink,
            ownerUserID: information.st_uid,
            bundleID: bundleID,
            version: version,
            signatureValid: signatureValidator.isValid(at: url)
        )
    }

    func installAtomically(from source: URL, to destination: URL) throws {
        let manager = FileManager.default
        let parent = destination.deletingLastPathComponent()
        try ensureSafeUserDirectory(parent)
        let staging = parent.appendingPathComponent(
            ".qwen-input-staging-\(UUID().uuidString)",
            isDirectory: true
        )
        let backup = parent.appendingPathComponent(
            ".qwen-input-last-known-good",
            isDirectory: true
        )
        try? manager.removeItem(at: staging)
        try manager.copyItem(at: source, to: staging)
        do {
            try? manager.removeItem(at: backup)
            if manager.fileExists(atPath: destination.path) {
                try manager.moveItem(at: destination, to: backup)
                backupURLs[destination.path] = backup
            }
            try manager.moveItem(at: staging, to: destination)
        } catch {
            try? manager.removeItem(at: staging)
            if manager.fileExists(atPath: backup.path),
               !manager.fileExists(atPath: destination.path) {
                try? manager.moveItem(at: backup, to: destination)
            }
            throw error
        }
    }

    func rollbackInstall(at destination: URL) throws {
        let manager = FileManager.default
        try? manager.removeItem(at: destination)
        if let backup = backupURLs.removeValue(forKey: destination.path),
           manager.fileExists(atPath: backup.path) {
            try manager.moveItem(at: backup, to: destination)
        }
    }

    func moveToTrash(_ url: URL) throws {
        var resultingURL: NSURL?
        try FileManager.default.trashItem(
            at: url,
            resultingItemURL: &resultingURL
        )
    }

    private func ensureSafeUserDirectory(_ url: URL) throws {
        let manager = FileManager.default
        if !manager.fileExists(atPath: url.path) {
            try manager.createDirectory(
                at: url,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
        var information = stat()
        guard lstat(url.path, &information) == 0,
              information.st_mode & S_IFMT == S_IFDIR,
              information.st_uid == geteuid() else {
            throw CocoaError(.fileWriteNoPermission)
        }
    }

}

enum SystemInputMethodLifecycleFactory {
    static func make() throws -> InputMethodLifecycle {
        let inputMethodBundleID = "ai.qwenaudio.agent.inputmethod"
        let executable = URL(fileURLWithPath: CommandLine.arguments[0])
            .standardizedFileURL
        let embedded = executable.deletingLastPathComponent()
            .appendingPathComponent("Qwen Input.app", isDirectory: true)
        guard let version = Bundle(url: embedded)?.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String else {
            throw InputMethodLifecycleError.embeddedBundleMissing
        }
        let installed = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Input Methods", isDirectory: true)
            .appendingPathComponent("Qwen Input.app", isDirectory: true)
        return InputMethodLifecycle(
            embeddedBundleURL: embedded,
            installedBundleURL: installed,
            expectedBundleID: inputMethodBundleID,
            expectedVersion: version,
            currentUserID: geteuid(),
            fileSystem: SystemInputMethodFileSystem(
                requirement: try NativeRuntimePeer.requirement(
                    for: inputMethodBundleID
                )
            ),
            registration: SystemInputSourceAPI()
        )
    }
}
