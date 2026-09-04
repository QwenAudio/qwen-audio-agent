import Foundation

public let gatewayRemoteAccessModelVersion = 1
public let gatewayClientProtocolVersion = "6.0.0"

public enum GatewayMobileError: Error, Equatable, LocalizedError, Sendable {
    case invalidInvitation
    case invitationExpired
    case invalidGatewayURL
    case insecureRemoteGateway
    case invalidPairingResponse
    case pairingFailed(status: Int, code: String?, message: String)
    case missingCredential
    case invalidServerMessage
    case gatewayError(code: String, message: String)
    case unexpectedReadyMessage

    public var errorDescription: String? {
        switch self {
        case .invalidInvitation:
            "The Gateway invitation is invalid."
        case .invitationExpired:
            "The Gateway invitation has expired."
        case .invalidGatewayURL:
            "The Gateway URL must be an HTTP origin without credentials, path, query, or fragment."
        case .insecureRemoteGateway:
            "A remote Gateway must use HTTPS."
        case .invalidPairingResponse:
            "The Gateway returned an invalid pairing response."
        case let .pairingFailed(status, _, message):
            "Gateway pairing failed with HTTP \(status): \(message)"
        case .missingCredential:
            "The Gateway credential is missing from secure storage."
        case .invalidServerMessage:
            "The Gateway returned an invalid protocol message."
        case let .gatewayError(code, message):
            "Gateway error \(code): \(message)"
        case .unexpectedReadyMessage:
            "The first Gateway protocol message was not session.ready."
        }
    }
}

public struct GatewayInvitation: Codable, Equatable, Sendable {
    public let version: Int
    public let gatewayURL: URL
    public let pairingCode: String
    public let expiresAt: Int64

    public init(
        version: Int = gatewayRemoteAccessModelVersion,
        gatewayURL: URL,
        pairingCode: String,
        expiresAt: Int64
    ) throws {
        guard version == gatewayRemoteAccessModelVersion,
              !pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              pairingCode.count <= 256,
              expiresAt > 0 else {
            throw GatewayMobileError.invalidInvitation
        }
        self.version = version
        self.gatewayURL = try GatewayURLPolicy.normalizedOrigin(gatewayURL)
        self.pairingCode = pairingCode
        self.expiresAt = expiresAt
    }

    public func requireActive(now: Date = Date()) throws {
        guard expiresAt > Int64(now.timeIntervalSince1970 * 1_000) else {
            throw GatewayMobileError.invitationExpired
        }
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            version: values.decode(Int.self, forKey: .version),
            gatewayURL: values.decode(URL.self, forKey: .gatewayURL),
            pairingCode: values.decode(String.self, forKey: .pairingCode),
            expiresAt: values.decode(Int64.self, forKey: .expiresAt)
        )
    }

    enum CodingKeys: String, CodingKey {
        case version
        case gatewayURL = "gateway_url"
        case pairingCode = "pairing_code"
        case expiresAt = "expires_at"
    }
}

public struct GatewayConnectionProfile: Codable, Equatable, Sendable {
    public let version: Int
    public let id: String
    public let gatewayURL: URL
    public let deviceID: String
    public let credentialReference: String
    public let clientInstanceID: String
    public let label: String?

    public init(
        version: Int = gatewayRemoteAccessModelVersion,
        id: String,
        gatewayURL: URL,
        deviceID: String,
        credentialReference: String,
        clientInstanceID: String,
        label: String? = nil
    ) throws {
        let identifiers = [id, deviceID, credentialReference, clientInstanceID]
        guard version == gatewayRemoteAccessModelVersion,
              identifiers.allSatisfy({
                  !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.count <= 128
              }),
              label.map({
                  !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.count <= 128
              }) ?? true else {
            throw GatewayMobileError.invalidPairingResponse
        }
        self.version = version
        self.id = id
        self.gatewayURL = try GatewayURLPolicy.normalizedOrigin(gatewayURL)
        self.deviceID = deviceID
        self.credentialReference = credentialReference
        self.clientInstanceID = clientInstanceID
        self.label = label
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            version: values.decode(Int.self, forKey: .version),
            id: values.decode(String.self, forKey: .id),
            gatewayURL: values.decode(URL.self, forKey: .gatewayURL),
            deviceID: values.decode(String.self, forKey: .deviceID),
            credentialReference: values.decode(String.self, forKey: .credentialReference),
            clientInstanceID: values.decode(String.self, forKey: .clientInstanceID),
            label: values.decodeIfPresent(String.self, forKey: .label)
        )
    }

    enum CodingKeys: String, CodingKey {
        case version
        case id
        case gatewayURL = "gateway_url"
        case deviceID = "device_id"
        case credentialReference = "credential_ref"
        case clientInstanceID = "client_instance_id"
        case label
    }
}

public struct GatewayDevice: Codable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let label: String?

    public init(id: String, type: String = "mobile", label: String? = nil) {
        self.id = id
        self.type = type
        self.label = label
    }
}

public enum GatewayURLPolicy {
    public static func normalizedOrigin(_ value: URL) throws -> URL {
        guard var components = URLComponents(url: value, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              components.host != nil,
              components.user == nil,
              components.password == nil,
              (components.path.isEmpty || components.path == "/"),
              components.query == nil,
              components.fragment == nil else {
            throw GatewayMobileError.invalidGatewayURL
        }
        components.scheme = scheme
        components.path = ""
        guard let normalized = components.url else {
            throw GatewayMobileError.invalidGatewayURL
        }
        return normalized
    }

    public static func requireSecureRemote(_ value: URL) throws {
        let normalized = try normalizedOrigin(value)
        guard normalized.scheme == "https" || isLiteralLoopback(normalized.host) else {
            throw GatewayMobileError.insecureRemoteGateway
        }
    }

    private static func isLiteralLoopback(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return ["127.0.0.1", "::1", "[::1]", "localhost"].contains(host)
    }
}
