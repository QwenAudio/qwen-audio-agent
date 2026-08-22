public enum NativeSessionState: String, Codable, CaseIterable, Sendable {
    case disabled
    case ready
    case arming
    case starting
    case listening
    case transcribing
    case paused
    case readyToSend = "ready-to-send"
    case blocked
    case cancelled
    case error

    public var capturesInput: Bool {
        switch self {
        case .starting, .listening, .transcribing:
            true
        default:
            false
        }
    }
}
