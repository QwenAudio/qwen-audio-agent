public enum BridgeConnectionAction: Equatable, Sendable {
    case none
    case failClosed
}

public struct BridgeConnectionState: Sendable {
    public private(set) var needsActivation = true

    private let failureThreshold: Int
    private var consecutiveFailures = 0
    private var emittedFailClosed = false

    public init(failureThreshold: Int = 3) {
        self.failureThreshold = max(1, failureThreshold)
    }

    public mutating func recordSuccess() {
        needsActivation = false
        consecutiveFailures = 0
        emittedFailClosed = false
    }

    public mutating func recordFailure() -> BridgeConnectionAction {
        needsActivation = true
        consecutiveFailures += 1
        guard consecutiveFailures >= failureThreshold,
              !emittedFailClosed else {
            return .none
        }
        emittedFailClosed = true
        return .failClosed
    }
}
