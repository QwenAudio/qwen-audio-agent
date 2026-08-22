import Darwin
import Foundation

public enum AuthenticatedUnixSocketError: Error, Equatable, Sendable {
    case pathTooLong
    case unsafeExistingPath
    case createFailed
    case bindFailed
    case listenFailed
    case connectFailed
    case credentialLookupFailed
    case userMismatch
    case signatureMismatch
    case truncated
    case oversized
    case ioFailure
    case invalidResponse
}

public final class AuthenticatedUnixSocketServer: @unchecked Sendable {
    public typealias Handler = @Sendable (Data) -> Data?

    private let runtimeDirectory: SecureRuntimeDirectory
    private let socketURL: URL
    private let peerRequirement: PeerCodeSigningRequirement
    private let handler: Handler
    private let lock = NSLock()
    private var listenerDescriptor: Int32 = -1

    public init(
        runtimeDirectory: SecureRuntimeDirectory,
        peerRequirement: PeerCodeSigningRequirement,
        handler: @escaping Handler
    ) {
        self.runtimeDirectory = runtimeDirectory
        socketURL = runtimeDirectory.socketURL()
        self.peerRequirement = peerRequirement
        self.handler = handler
    }

    public func start() throws {
        try runtimeDirectory.prepare()
        try rejectUnsafeExistingSocket()
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            throw AuthenticatedUnixSocketError.createFailed
        }
        do {
            try configureNoSigPipe(descriptor)
            var address = try makeUnixAddress(path: socketURL.path)
            let result = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(
                        descriptor,
                        $0,
                        socklen_t(MemoryLayout<sockaddr_un>.size)
                    )
                }
            }
            guard result == 0 else {
                throw AuthenticatedUnixSocketError.bindFailed
            }
            guard chmod(socketURL.path, 0o600) == 0 else {
                throw AuthenticatedUnixSocketError.ioFailure
            }
            guard listen(descriptor, 4) == 0 else {
                throw AuthenticatedUnixSocketError.listenFailed
            }
        } catch {
            close(descriptor)
            unlink(socketURL.path)
            throw error
        }

        lock.lock()
        listenerDescriptor = descriptor
        lock.unlock()
        Thread.detachNewThread { [weak self] in
            self?.acceptLoop(descriptor: descriptor)
        }
    }

    public func stop() {
        lock.lock()
        let descriptor = listenerDescriptor
        listenerDescriptor = -1
        lock.unlock()
        if descriptor >= 0 {
            shutdown(descriptor, SHUT_RDWR)
            close(descriptor)
        }
        unlink(socketURL.path)
    }

    private func acceptLoop(descriptor: Int32) {
        while true {
            let connection = accept(descriptor, nil, nil)
            if connection < 0 { return }
            configureNoSigPipeIgnoringFailure(connection)
            handle(connection: connection)
            close(connection)
        }
    }

    private func handle(connection: Int32) {
        guard verifyPeer(
            descriptor: connection,
            requirement: peerRequirement
        ) else { return }
        guard let request = try? readFrame(from: connection),
              let response = handler(request) else { return }
        try? writeAll(response, to: connection)
    }

    private func rejectUnsafeExistingSocket() throws {
        var information = stat()
        guard lstat(socketURL.path, &information) == 0 else {
            if errno == ENOENT { return }
            throw AuthenticatedUnixSocketError.ioFailure
        }
        guard information.st_uid == geteuid(),
              information.st_mode & S_IFMT == S_IFSOCK else {
            throw AuthenticatedUnixSocketError.unsafeExistingPath
        }
        guard unlink(socketURL.path) == 0 else {
            throw AuthenticatedUnixSocketError.ioFailure
        }
    }
}

public enum AuthenticatedUnixSocketClient {
    public static func exchange(
        _ request: Data,
        socketURL: URL,
        peerRequirement: PeerCodeSigningRequirement
    ) throws -> Data {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            throw AuthenticatedUnixSocketError.createFailed
        }
        defer { close(descriptor) }
        try configureNoSigPipe(descriptor)
        var address = try makeUnixAddress(path: socketURL.path)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(
                    descriptor,
                    $0,
                    socklen_t(MemoryLayout<sockaddr_un>.size)
                )
            }
        }
        guard result == 0 else {
            throw AuthenticatedUnixSocketError.connectFailed
        }
        guard verifyPeer(
            descriptor: descriptor,
            requirement: peerRequirement
        ) else {
            throw AuthenticatedUnixSocketError.signatureMismatch
        }
        try writeAll(request, to: descriptor)
        return try readFrame(from: descriptor)
    }
}

private func makeUnixAddress(path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    let bytes = Array(path.utf8CString)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    guard bytes.count <= capacity else {
        throw AuthenticatedUnixSocketError.pathTooLong
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    address.sun_family = sa_family_t(AF_UNIX)
    path.withCString { source in
        withUnsafeMutablePointer(to: &address.sun_path.0) { destination in
            _ = strlcpy(destination, source, capacity)
        }
    }
    return address
}

private func verifyPeer(
    descriptor: Int32,
    requirement: PeerCodeSigningRequirement
) -> Bool {
    var peerUserID = uid_t.max
    var peerGroupID = gid_t.max
    guard getpeereid(descriptor, &peerUserID, &peerGroupID) == 0,
          peerUserID == geteuid() else {
        return false
    }
    var peerProcessID = pid_t(0)
    var length = socklen_t(MemoryLayout<pid_t>.size)
    guard getsockopt(
        descriptor,
        SOL_LOCAL,
        LOCAL_PEERPID,
        &peerProcessID,
        &length
    ) == 0, peerProcessID > 0 else {
        return false
    }
    return DynamicPeerCodeValidator.validate(
        processID: peerProcessID,
        requirement: requirement
    )
}

private func configureNoSigPipe(_ descriptor: Int32) throws {
    var enabled: Int32 = 1
    guard setsockopt(
        descriptor,
        SOL_SOCKET,
        SO_NOSIGPIPE,
        &enabled,
        socklen_t(MemoryLayout<Int32>.size)
    ) == 0 else {
        throw AuthenticatedUnixSocketError.ioFailure
    }
}

private func configureNoSigPipeIgnoringFailure(_ descriptor: Int32) {
    try? configureNoSigPipe(descriptor)
}

private func readFrame(from descriptor: Int32) throws -> Data {
    let header = try readExactly(4, from: descriptor)
    let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    guard length > 0 else { throw AuthenticatedUnixSocketError.truncated }
    guard length <= UInt32(FrameCodec.maximumPayloadBytes) else {
        throw AuthenticatedUnixSocketError.oversized
    }
    return header + (try readExactly(Int(length), from: descriptor))
}

private func readExactly(_ count: Int, from descriptor: Int32) throws -> Data {
    var data = Data(count: count)
    var offset = 0
    while offset < count {
        let readCount = data.withUnsafeMutableBytes { buffer in
            Darwin.read(
                descriptor,
                buffer.baseAddress!.advanced(by: offset),
                count - offset
            )
        }
        guard readCount > 0 else {
            throw AuthenticatedUnixSocketError.truncated
        }
        offset += readCount
    }
    return data
}

private func writeAll(_ data: Data, to descriptor: Int32) throws {
    try data.withUnsafeBytes { buffer in
        guard let base = buffer.baseAddress else {
            throw AuthenticatedUnixSocketError.ioFailure
        }
        var offset = 0
        while offset < buffer.count {
            let written = Darwin.write(
                descriptor,
                base.advanced(by: offset),
                buffer.count - offset
            )
            guard written > 0 else {
                throw AuthenticatedUnixSocketError.ioFailure
            }
            offset += written
        }
    }
}
