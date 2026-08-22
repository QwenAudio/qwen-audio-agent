public enum GateSignal: Equatable, Sendable {
    case ready
    case unavailable
    case unknown
}
public struct SafetyContext: Equatable, Sendable {
    public let featureEnabled: Bool
    public let desktopConnected: Bool
    public let target: GateSignal
    public let statusVisibility: GateSignal
    public let inputSource: GateSignal

    public init(
        featureEnabled: Bool,
        desktopConnected: Bool,
        target: GateSignal,
        statusVisibility: GateSignal,
        inputSource: GateSignal
    ) {
        self.featureEnabled = featureEnabled
        self.desktopConnected = desktopConnected
        self.target = target
        self.statusVisibility = statusVisibility
        self.inputSource = inputSource
    }
}

public enum SafetyBlockReason: Equatable, Sendable {
    case featureDisabled
    case desktopDisconnected
    case targetUnavailable
    case targetUnknown
    case statusHidden
    case statusUnknown
    case inputSourceInactive
    case inputSourceUnknown
    case secureEventInput
}

public enum SafetyDecision: Equatable, Sendable {
    case captureAllowed
    case idle
    case blocked(reason: SafetyBlockReason, removeOwnedPartial: Bool)
}

public struct SafetyGate: Sendable {
    private let secureEventInputEnabled: @Sendable () -> Bool

    public init(secureEventInputEnabled: @escaping @Sendable () -> Bool) {
        self.secureEventInputEnabled = secureEventInputEnabled
    }

    public func evaluate(
        state: NativeSessionState,
        context: SafetyContext,
        hasOwnedPartial: Bool
    ) -> SafetyDecision {
        let removeOwnedPartial = state.capturesInput || hasOwnedPartial
        if secureEventInputEnabled() {
            return .blocked(
                reason: .secureEventInput,
                removeOwnedPartial: removeOwnedPartial
            )
        }
        if !context.featureEnabled {
            return .blocked(
                reason: .featureDisabled,
                removeOwnedPartial: removeOwnedPartial
            )
        }
        if !context.desktopConnected {
            return .blocked(
                reason: .desktopDisconnected,
                removeOwnedPartial: removeOwnedPartial
            )
        }
        switch context.target {
        case .ready:
            break
        case .unavailable:
            return .blocked(
                reason: .targetUnavailable,
                removeOwnedPartial: removeOwnedPartial
            )
        case .unknown:
            return .blocked(
                reason: .targetUnknown,
                removeOwnedPartial: removeOwnedPartial
            )
        }
        switch context.statusVisibility {
        case .ready:
            break
        case .unavailable:
            return .blocked(
                reason: .statusHidden,
                removeOwnedPartial: removeOwnedPartial
            )
        case .unknown:
            return .blocked(
                reason: .statusUnknown,
                removeOwnedPartial: removeOwnedPartial
            )
        }
        switch context.inputSource {
        case .ready:
            break
        case .unavailable:
            return .blocked(
                reason: .inputSourceInactive,
                removeOwnedPartial: removeOwnedPartial
            )
        case .unknown:
            return .blocked(
                reason: .inputSourceUnknown,
                removeOwnedPartial: removeOwnedPartial
            )
        }
        return state.capturesInput ? .captureAllowed : .idle
    }
}
