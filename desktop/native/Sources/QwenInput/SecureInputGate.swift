import Carbon.HIToolbox
import QwenInputCore

enum SystemSecureInputGate {
    static func makeSafetyGate() -> SafetyGate {
        SafetyGate(secureEventInputEnabled: {
            IsSecureEventInputEnabled()
        })
    }
}
