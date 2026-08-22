import AppKit
import InputMethodKit
import QwenInputCore

@objc(QwenInputController)
final class QwenInputController: IMKInputController, @unchecked Sendable {
    private var sessionState = NativeSessionState.ready
    private var targetToken: ControllerTargetToken?
    private var ledger: SessionLedger?
    private let clientAdapter = TextClientAdapter()
    private let safetyGate = SystemSecureInputGate.makeSafetyGate()

    override func activateServer(_ sender: Any!) {
        super.activateServer(sender)
        guard let client = IMKTextClientAdapter(sender),
              let clientIdentifier = client.uniqueIdentifier,
              !clientIdentifier.isEmpty else {
            sessionState = .blocked
            return
        }

        let token = ControllerRegistry.shared.activate(
            self,
            clientIdentifier: clientIdentifier
        )
        targetToken = token
        ledger = SessionLedger(
            sessionID: UUID(),
            generation: token.generation,
            targetID: token.targetID
        )
        sessionState = .ready
    }

    override func deactivateServer(_ sender: Any!) {
        removeOwnedPartialIfPossible(from: sender)
        if let targetToken {
            ControllerRegistry.shared.deactivate(
                self,
                targetID: targetToken.targetID
            )
        }
        invalidateSession()
        super.deactivateServer(sender)
    }

    override func inputControllerWillClose() {
        if let targetToken {
            ControllerRegistry.shared.close(
                self,
                targetID: targetToken.targetID
            )
        }
        invalidateSession()
        super.inputControllerWillClose()
    }

    override func handle(_ event: NSEvent!, client sender: Any!) -> Bool {
        _ = event
        _ = sender
        return InputEventPolicy.shouldConsumePhysicalKey(in: sessionState)
    }

    func apply(_ effect: ClientTextEffect, sender: Any) -> Bool {
        guard let client = IMKTextClientAdapter(sender) else { return false }
        let context = SafetyContext(
            featureEnabled: true,
            desktopConnected: false,
            target: targetToken == nil ? .unknown : .ready,
            statusVisibility: .unknown,
            inputSource: .ready
        )
        let decision = safetyGate.evaluate(
            state: sessionState,
            context: context,
            hasOwnedPartial: ledger?.ownedMarkedRange != nil
        )
        guard decision == .captureAllowed else { return false }
        return (try? clientAdapter.apply(effect, to: client).get()) != nil
    }

    private func removeOwnedPartialIfPossible(from sender: Any?) {
        guard var ledger,
              let token = targetToken,
              let client = IMKTextClientAdapter(sender),
              let effect = try? ledger.cancel(
                  clientMarkedRange: client.markedRange,
                  generation: token.generation,
                  targetID: token.targetID
              ).get() else {
            return
        }
        _ = clientAdapter.apply(effect, to: client)
        self.ledger = ledger
    }

    private func invalidateSession() {
        sessionState = .cancelled
        targetToken = nil
        ledger = nil
    }
}
