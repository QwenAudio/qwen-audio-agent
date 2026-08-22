import Foundation

public protocol InputSourceAPI: AnyObject {
    func currentKeyboardSourceID() -> String?
    func containsInputSource(id: String) -> Bool
    func isInputSourceEnabled(id: String) -> Bool
    func selectInputSource(id: String) -> Bool
    func registerInputSource(at url: URL) -> Bool
}

public struct InputSourceRecoveryInstruction: Equatable, Sendable {
    public let previousSourceID: String
    public let expectedCurrentSourceID: String

    public init(previousSourceID: String, expectedCurrentSourceID: String) {
        self.previousSourceID = previousSourceID
        self.expectedCurrentSourceID = expectedCurrentSourceID
    }
}

public enum InputSourceBeginResult: Equatable, Sendable {
    case selected(previousSourceID: String)
    case alreadySelected
    case currentSourceUnavailable
    case qwenInputUnavailable
    case qwenInputDisabled
    case selectionFailed
}

public enum InputSourceRestoreResult: Equatable, Sendable {
    case restored(sourceID: String)
    case alreadyRestored
    case currentSourceChanged(actualSourceID: String?)
    case previousSourceUnavailable
    case restorationFailed
}

/// Selects Qwen Input for one native-input session and restores the source that
/// was active before that session. Restoration is intentionally compare-and-set:
/// a source selected by the user while dictation is active is never overwritten.
public struct InputSourceCoordinator {
    public private(set) var recoveryInstruction: InputSourceRecoveryInstruction?

    private let qwenInputSourceID: String
    private let api: InputSourceAPI

    public init(qwenInputSourceID: String, api: InputSourceAPI) {
        self.qwenInputSourceID = qwenInputSourceID
        self.api = api
    }

    public mutating func begin() -> InputSourceBeginResult {
        if recoveryInstruction != nil {
            return .alreadySelected
        }

        guard let currentSourceID = api.currentKeyboardSourceID() else {
            return .currentSourceUnavailable
        }
        guard api.containsInputSource(id: qwenInputSourceID) else {
            return .qwenInputUnavailable
        }
        guard api.isInputSourceEnabled(id: qwenInputSourceID) else {
            return .qwenInputDisabled
        }
        guard currentSourceID != qwenInputSourceID else {
            return .alreadySelected
        }
        guard api.selectInputSource(id: qwenInputSourceID) else {
            return .selectionFailed
        }

        recoveryInstruction = InputSourceRecoveryInstruction(
            previousSourceID: currentSourceID,
            expectedCurrentSourceID: qwenInputSourceID
        )
        return .selected(previousSourceID: currentSourceID)
    }

    public mutating func restore() -> InputSourceRestoreResult {
        guard let recoveryInstruction else {
            return .alreadyRestored
        }

        let currentSourceID = api.currentKeyboardSourceID()
        guard currentSourceID == recoveryInstruction.expectedCurrentSourceID else {
            return .currentSourceChanged(actualSourceID: currentSourceID)
        }
        guard api.containsInputSource(id: recoveryInstruction.previousSourceID),
              api.isInputSourceEnabled(id: recoveryInstruction.previousSourceID)
        else {
            return .previousSourceUnavailable
        }
        guard api.selectInputSource(id: recoveryInstruction.previousSourceID) else {
            return .restorationFailed
        }

        self.recoveryInstruction = nil
        return .restored(sourceID: recoveryInstruction.previousSourceID)
    }
}
