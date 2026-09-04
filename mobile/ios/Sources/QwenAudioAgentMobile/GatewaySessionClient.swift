import Foundation

public struct GatewaySessionConfiguration: Sendable {
    public var sessionID: String
    public var clientVersion: String?
    public var clientInstanceID: String
    public var clientLabel: String?
    public var capabilities: [String]
    public var locale: String?
    public var timeZone: String?
    public var voiceEnabled: Bool
    public var inputEnabled: Bool
    public var outputEnabled: Bool
    public var textOnly: Bool
    public var wakeWordOnly: Bool
    public var takeover: Bool

    public init(
        sessionID: String = "main",
        clientVersion: String? = nil,
        clientInstanceID: String,
        clientLabel: String? = nil,
        capabilities: [String] = GatewayMobileCapabilities.reference,
        locale: String? = Locale.current.identifier,
        timeZone: String? = TimeZone.current.identifier,
        voiceEnabled: Bool = true,
        inputEnabled: Bool = true,
        outputEnabled: Bool = true,
        textOnly: Bool = false,
        wakeWordOnly: Bool = false,
        takeover: Bool = false
    ) {
        self.sessionID = sessionID
        self.clientVersion = clientVersion
        self.clientInstanceID = clientInstanceID
        self.clientLabel = clientLabel
        self.capabilities = capabilities
        self.locale = locale
        self.timeZone = timeZone
        self.voiceEnabled = voiceEnabled
        self.inputEnabled = inputEnabled
        self.outputEnabled = outputEnabled
        self.textOnly = textOnly
        self.wakeWordOnly = wakeWordOnly
        self.takeover = takeover
    }
}

public enum GatewayMobileCapabilities {
    public static let inputAudio = "input.audio"
    public static let inputText = "input.text"
    public static let inputImage = "input.image"
    public static let inputFile = "input.file"
    public static let playbackReceipts = "playback.receipts"
    public static let taskCommands = "tasks.commands"
    public static let permissionRespond = "permissions.respond"
    public static let inputRespond = "tasks.input.respond"
    public static let conversationHistory = "conversation.history"
    public static let clientEvents = "client.events"
    public static let outputVoice = "session.output_voice"
    public static let replay = "session.replay"
    public static let takeover = "session.takeover"

    public static let reference = [
        inputAudio,
        inputText,
        inputImage,
        inputFile,
        playbackReceipts,
        taskCommands,
        permissionRespond,
        inputRespond,
        conversationHistory,
        clientEvents,
        outputVoice,
        replay,
    ]
}

public struct GatewaySessionReady: Decodable, Equatable, Sendable {
    public let type: String
    public let eventID: String
    public let requestEventID: String
    public let protocolVersion: String
    public let sessionID: String
    public let capabilities: [String]

    enum CodingKeys: String, CodingKey {
        case type
        case eventID = "event_id"
        case requestEventID = "request_event_id"
        case protocolVersion = "protocol_version"
        case sessionID = "session_id"
        case capabilities
    }
}

public actor GatewaySessionClient {
    private let session: URLSession
    private var task: URLSessionWebSocketTask?

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func connect(
        profile: GatewayConnectionProfile,
        credentialStore: any GatewayCredentialStoring,
        configuration: GatewaySessionConfiguration
    ) async throws -> GatewaySessionReady {
        guard let credential = try await credentialStore.credential(for: profile.credentialReference),
              !credential.isEmpty else {
            throw GatewayMobileError.missingCredential
        }
        try GatewayURLPolicy.requireSecureRemote(profile.gatewayURL)
        let url = try websocketURL(baseURL: profile.gatewayURL, sessionID: configuration.sessionID)
        var request = URLRequest(url: url)
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: request)
        task = socket
        socket.resume()

        let hello = GatewaySessionHello(configuration: configuration)
        let helloData = try JSONEncoder.gateway.encode(hello)
        guard let helloText = String(data: helloData, encoding: .utf8) else {
            throw GatewayMobileError.invalidServerMessage
        }
        try await socket.send(.string(helloText))
        let message = try await socket.receive()
        let data: Data
        switch message {
        case let .string(value):
            guard let value = value.data(using: .utf8) else {
                throw GatewayMobileError.invalidServerMessage
            }
            data = value
        case let .data(value):
            data = value
        @unknown default:
            throw GatewayMobileError.invalidServerMessage
        }
        let envelope = try JSONDecoder().decode(GatewayServerEnvelope.self, from: data)
        if envelope.type == "error" {
            throw GatewayMobileError.gatewayError(
                code: envelope.error?.code ?? "unknown",
                message: envelope.error?.message ?? "Gateway rejected the session"
            )
        }
        guard envelope.type == "session.ready",
              let ready = try? JSONDecoder().decode(GatewaySessionReady.self, from: data),
              ready.requestEventID == hello.eventID else {
            throw GatewayMobileError.unexpectedReadyMessage
        }
        return ready
    }

    public func sendJSON(_ data: Data) async throws {
        guard let task else { throw GatewayMobileError.invalidServerMessage }
        try await task.send(.data(data))
    }

    public func receive() async throws -> URLSessionWebSocketTask.Message {
        guard let task else { throw GatewayMobileError.invalidServerMessage }
        return try await task.receive()
    }

    public func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func websocketURL(baseURL: URL, sessionID: String) throws -> URL {
        guard var components = URLComponents(
            url: baseURL.appending(path: "api/realtime"),
            resolvingAgainstBaseURL: false
        ) else {
            throw GatewayMobileError.invalidGatewayURL
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "sessionId", value: sessionID)]
        guard let url = components.url else { throw GatewayMobileError.invalidGatewayURL }
        return url
    }
}

struct GatewaySessionHello: Encodable {
    let type = "session.hello"
    let eventID: String
    let protocolRange = ProtocolRange()
    let client: Client
    let capabilities: [String]
    let locale: String?
    let timeZone: String?
    let connection: Connection

    init(configuration: GatewaySessionConfiguration, eventID: String? = nil) {
        self.eventID = eventID
            ?? "evt_mobile_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())"
        client = Client(
            type: "mobile",
            version: configuration.clientVersion,
            instanceID: configuration.clientInstanceID,
            label: configuration.clientLabel
        )
        var requested = Array(Set(configuration.capabilities)).sorted()
        if configuration.takeover && !requested.contains(GatewayMobileCapabilities.takeover) {
            requested.append(GatewayMobileCapabilities.takeover)
        }
        capabilities = requested
        locale = configuration.locale
        timeZone = configuration.timeZone
        connection = Connection(configuration: configuration)
    }

    struct ProtocolRange: Encodable {
        let min = gatewayClientProtocolVersion
        let max = gatewayClientProtocolVersion
    }

    struct Client: Encodable {
        let type: String
        let version: String?
        let instanceID: String
        let label: String?

        enum CodingKeys: String, CodingKey {
            case type
            case version
            case instanceID = "instance_id"
            case label
        }
    }

    struct Connection: Encodable {
        let voiceEnabled: Bool
        let inputEnabled: Bool
        let outputEnabled: Bool
        let textOnly: Bool
        let wakeWordOnly: Bool
        let takeover: Bool

        init(configuration: GatewaySessionConfiguration) {
            voiceEnabled = configuration.voiceEnabled
            inputEnabled = configuration.inputEnabled
            outputEnabled = configuration.outputEnabled
            textOnly = configuration.textOnly
            wakeWordOnly = configuration.wakeWordOnly
            takeover = configuration.takeover
        }

        enum CodingKeys: String, CodingKey {
            case voiceEnabled = "voice_enabled"
            case inputEnabled = "input_enabled"
            case outputEnabled = "output_enabled"
            case textOnly = "text_only"
            case wakeWordOnly = "wake_word_only"
            case takeover
        }
    }

    enum CodingKeys: String, CodingKey {
        case type
        case eventID = "event_id"
        case protocolRange = "protocol"
        case client
        case capabilities
        case locale
        case timeZone = "time_zone"
        case connection
    }
}

private struct GatewayServerEnvelope: Decodable {
    let type: String
    let error: GatewayProtocolFailure?
}

private struct GatewayProtocolFailure: Decodable {
    let code: String
    let message: String
}
