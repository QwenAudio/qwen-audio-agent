import Foundation

public enum NativeInputMessageType: String, Codable, CaseIterable, Sendable {
    case bridgeReady = "bridge.ready"
    case sessionArm = "session.arm"
    case sessionPartial = "session.partial"
    case sessionFinal = "session.final"
    case sessionCancel = "session.cancel"
    case sessionPause = "session.pause"
    case sessionResume = "session.resume"
    case sessionState = "session.state"
    case bridgeStop = "bridge.stop"
    case bridgeError = "bridge.error"
}

public struct NativeInputMessage: Codable, Equatable, Sendable {
    public let type: NativeInputMessageType
    public let text: String?
    public let state: NativeSessionState?
    public let reason: String?

    public init(
        type: NativeInputMessageType,
        text: String? = nil,
        state: NativeSessionState? = nil,
        reason: String? = nil
    ) {
        self.type = type
        self.text = text
        self.state = state
        self.reason = reason
    }
}

public enum FrameCodecError: Error, Equatable, Sendable {
    case zeroLength
    case oversized
    case truncated
    case trailingBytes
    case invalidUTF8
    case invalidJSON
}

public enum FrameCodec {
    public static let maximumPayloadBytes = 65_536
    private static let headerBytes = 4

    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        let payload: Data
        do {
            payload = try JSONEncoder().encode(value)
        } catch {
            throw FrameCodecError.invalidJSON
        }
        guard !payload.isEmpty else { throw FrameCodecError.zeroLength }
        guard payload.count <= maximumPayloadBytes else {
            throw FrameCodecError.oversized
        }

        let length = UInt32(payload.count)
        var frame = Data(capacity: headerBytes + payload.count)
        frame.append(UInt8((length >> 24) & 0xff))
        frame.append(UInt8((length >> 16) & 0xff))
        frame.append(UInt8((length >> 8) & 0xff))
        frame.append(UInt8(length & 0xff))
        frame.append(payload)
        return frame
    }

    public static func decode<T: Decodable, Bytes: DataProtocol>(
        _ type: T.Type,
        from bytes: Bytes
    ) throws -> T {
        let frame = Data(bytes)
        guard frame.count >= headerBytes else { throw FrameCodecError.truncated }
        let length = try payloadLength(in: frame)
        let expected = headerBytes + length
        guard frame.count >= expected else { throw FrameCodecError.truncated }
        guard frame.count == expected else { throw FrameCodecError.trailingBytes }
        return try decodePayload(type, from: frame.dropFirst(headerBytes))
    }

    public static func decodePayload<T: Decodable, Bytes: DataProtocol>(
        _ type: T.Type,
        from bytes: Bytes
    ) throws -> T {
        let payload = Data(bytes)
        guard !payload.isEmpty else { throw FrameCodecError.zeroLength }
        guard payload.count <= maximumPayloadBytes else {
            throw FrameCodecError.oversized
        }
        guard String(data: payload, encoding: .utf8) != nil else {
            throw FrameCodecError.invalidUTF8
        }
        do {
            return try JSONDecoder().decode(type, from: payload)
        } catch {
            throw FrameCodecError.invalidJSON
        }
    }

    static func payloadLength(in header: Data) throws -> Int {
        guard header.count >= headerBytes else { throw FrameCodecError.truncated }
        let length = header.prefix(headerBytes).reduce(UInt32(0)) {
            ($0 << 8) | UInt32($1)
        }
        guard length > 0 else { throw FrameCodecError.zeroLength }
        guard length <= UInt32(maximumPayloadBytes) else {
            throw FrameCodecError.oversized
        }
        return Int(length)
    }
}

public struct FrameStreamDecoder: Sendable {
    private var buffer = Data()

    public init() {}

    public mutating func append<Bytes: DataProtocol>(
        _ bytes: Bytes
    ) throws -> [Data] {
        buffer.append(contentsOf: bytes)
        var frames: [Data] = []

        while buffer.count >= 4 {
            let length = try FrameCodec.payloadLength(in: buffer)
            let frameLength = 4 + length
            guard buffer.count >= frameLength else { break }
            frames.append(buffer.subdata(in: 4..<frameLength))
            buffer.removeSubrange(0..<frameLength)
        }
        return frames
    }

    public func finish() throws {
        guard buffer.isEmpty else { throw FrameCodecError.truncated }
    }
}
