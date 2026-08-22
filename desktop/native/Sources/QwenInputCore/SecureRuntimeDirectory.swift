import Darwin
import Foundation

public enum SecureRuntimeDirectoryError: Error, Equatable, Sendable {
    case symbolicLink
    case unsafeOwner
    case unsafeMode
    case notDirectory
    case ioFailure
}

public struct SecureRuntimeDirectory: Sendable {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    public func prepare() throws {
        var information = stat()
        if lstat(url.path, &information) != 0 {
            guard errno == ENOENT else {
                throw SecureRuntimeDirectoryError.ioFailure
            }
            do {
                try FileManager.default.createDirectory(
                    at: url,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700]
                )
            } catch {
                throw SecureRuntimeDirectoryError.ioFailure
            }
            guard chmod(url.path, 0o700) == 0 else {
                throw SecureRuntimeDirectoryError.ioFailure
            }
        }
        try validate()
    }

    public func validate() throws {
        var information = stat()
        guard lstat(url.path, &information) == 0 else {
            throw SecureRuntimeDirectoryError.ioFailure
        }
        guard information.st_mode & S_IFMT != S_IFLNK else {
            throw SecureRuntimeDirectoryError.symbolicLink
        }
        guard information.st_mode & S_IFMT == S_IFDIR else {
            throw SecureRuntimeDirectoryError.notDirectory
        }
        guard information.st_uid == geteuid() else {
            throw SecureRuntimeDirectoryError.unsafeOwner
        }
        guard information.st_mode & 0o777 == 0o700 else {
            throw SecureRuntimeDirectoryError.unsafeMode
        }
    }

    public func socketURL(named name: String = "control.sock") -> URL {
        url.appendingPathComponent(name)
    }
}
