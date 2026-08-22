import Foundation
import QwenInputCore

final class ControllerRegistry: @unchecked Sendable {
    static let shared = ControllerRegistry()

    private let lock = NSLock()
    private weak var activeController: QwenInputController?
    private var state = ControllerRegistryState()

    private init() {}

    func activate(
        _ controller: QwenInputController,
        clientIdentifier: String
    ) -> ControllerTargetToken {
        lock.lock()
        defer { lock.unlock() }
        activeController = controller
        return state.activate(clientIdentifier: clientIdentifier)
    }

    func deactivate(
        _ controller: QwenInputController,
        targetID: UUID
    ) {
        lock.lock()
        defer { lock.unlock() }
        guard activeController === controller else { return }
        _ = state.deactivate(targetID: targetID)
        activeController = nil
    }

    func close(
        _ controller: QwenInputController,
        targetID: UUID
    ) {
        lock.lock()
        defer { lock.unlock() }
        guard activeController === controller else { return }
        _ = state.close(targetID: targetID)
        activeController = nil
    }
}
