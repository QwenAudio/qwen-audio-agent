import Foundation

public struct InputMethodArtifactInspection: Equatable, Sendable {
    public let symbolicLink: Bool
    public let ownerUserID: UInt32
    public let bundleID: String
    public let version: String
    public let signatureValid: Bool

    public init(
        symbolicLink: Bool,
        ownerUserID: UInt32,
        bundleID: String,
        version: String,
        signatureValid: Bool
    ) {
        self.symbolicLink = symbolicLink
        self.ownerUserID = ownerUserID
        self.bundleID = bundleID
        self.version = version
        self.signatureValid = signatureValid
    }
}

public struct InputMethodLifecycleStatus: Equatable, Sendable {
    public let installed: Bool
    public let registered: Bool
    public let enabled: Bool
    public let version: String

    public init(
        installed: Bool,
        registered: Bool,
        enabled: Bool,
        version: String
    ) {
        self.installed = installed
        self.registered = registered
        self.enabled = enabled
        self.version = version
    }
}

public enum InputMethodLifecycleError: Error, Equatable, Sendable {
    case embeddedBundleMissing
    case unsafeEmbeddedBundle
    case registrationFailed
    case disableFailed
}

public protocol InputMethodLifecycleFileSystem: AnyObject {
    func inspect(at url: URL) -> InputMethodArtifactInspection?
    func installAtomically(from source: URL, to destination: URL) throws
    func rollbackInstall(at destination: URL) throws
    func moveToTrash(_ url: URL) throws
}

public protocol InputMethodRegistration: AnyObject {
    func containsInputSource() -> Bool
    func isInputSourceEnabled() -> Bool
    func registerInputSource(at url: URL) -> Bool
    func disableInputSource() -> Bool
}

public final class InputMethodLifecycle {
    private let embeddedBundleURL: URL
    private let installedBundleURL: URL
    private let expectedBundleID: String
    private let expectedVersion: String
    private let currentUserID: UInt32
    private let fileSystem: InputMethodLifecycleFileSystem
    private let registration: InputMethodRegistration

    public init(
        embeddedBundleURL: URL,
        installedBundleURL: URL,
        expectedBundleID: String,
        expectedVersion: String,
        currentUserID: UInt32,
        fileSystem: InputMethodLifecycleFileSystem,
        registration: InputMethodRegistration
    ) {
        self.embeddedBundleURL = embeddedBundleURL
        self.installedBundleURL = installedBundleURL
        self.expectedBundleID = expectedBundleID
        self.expectedVersion = expectedVersion
        self.currentUserID = currentUserID
        self.fileSystem = fileSystem
        self.registration = registration
    }

    public func status() throws -> InputMethodLifecycleStatus {
        guard let inspection = fileSystem.inspect(at: installedBundleURL),
              valid(inspection, installed: true) else {
            return InputMethodLifecycleStatus(
                installed: false,
                registered: false,
                enabled: false,
                version: ""
            )
        }
        let registered = registration.containsInputSource()
        return InputMethodLifecycleStatus(
            installed: true,
            registered: registered,
            enabled: registered && registration.isInputSourceEnabled(),
            version: inspection.version
        )
    }

    public func install() throws -> InputMethodLifecycleStatus {
        guard let embedded = fileSystem.inspect(at: embeddedBundleURL) else {
            throw InputMethodLifecycleError.embeddedBundleMissing
        }
        guard valid(embedded, installed: false) else {
            throw InputMethodLifecycleError.unsafeEmbeddedBundle
        }
        try fileSystem.installAtomically(
            from: embeddedBundleURL,
            to: installedBundleURL
        )
        guard registration.registerInputSource(at: installedBundleURL) else {
            try? fileSystem.rollbackInstall(at: installedBundleURL)
            throw InputMethodLifecycleError.registrationFailed
        }
        return try status()
    }

    public func repair() throws -> InputMethodLifecycleStatus {
        try install()
    }

    public func uninstall() throws -> InputMethodLifecycleStatus {
        if registration.containsInputSource(),
           !registration.disableInputSource() {
            throw InputMethodLifecycleError.disableFailed
        }
        if fileSystem.inspect(at: installedBundleURL) != nil {
            try fileSystem.moveToTrash(installedBundleURL)
        }
        return InputMethodLifecycleStatus(
            installed: false,
            registered: false,
            enabled: false,
            version: ""
        )
    }

    private func valid(
        _ inspection: InputMethodArtifactInspection,
        installed: Bool
    ) -> Bool {
        guard !inspection.symbolicLink,
              inspection.bundleID == expectedBundleID,
              inspection.version == expectedVersion,
              inspection.signatureValid else { return false }
        return installed
            ? inspection.ownerUserID == currentUserID
            : inspection.ownerUserID == currentUserID || inspection.ownerUserID == 0
    }
}
