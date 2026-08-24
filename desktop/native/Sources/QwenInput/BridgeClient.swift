import Foundation
import QwenInputCore

final class InputBridgeClient: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ai.qwenaudio.agent.input.poll")
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private var target: NativeOperationTarget?
    private weak var controller: QwenInputController?
    private var sender: AnyObject?
    private var polling = false
    private var connection = BridgeConnectionState()

    func activate(
        controller: QwenInputController,
        sender: AnyObject,
        target: NativeOperationTarget
    ) {
        deactivate()
        self.controller = controller
        self.sender = sender
        self.target = target
        connection = BridgeConnectionState()
        queue.async { [weak self] in
            guard let self else { return }
            let activation = NativeInputMessage(
                type: .imeActivate,
                sessionID: target.sessionID,
                generation: target.generation,
                targetID: target.targetID
            )
            if self.exchange(activation)?.accepted == true {
                self.recordConnectionSuccess()
            } else {
                self.recordConnectionFailure(
                    controller: controller,
                    target: target
                )
            }
            self.startPolling()
        }
    }

    func deactivate() {
        lock.lock()
        let oldTimer = timer
        timer = nil
        let oldTarget = target
        target = nil
        controller = nil
        sender = nil
        polling = false
        connection = BridgeConnectionState()
        lock.unlock()
        oldTimer?.cancel()
        if let oldTarget {
            queue.async { [weak self] in
                _ = self?.exchange(NativeInputMessage(
                    type: .imeDeactivate,
                    sessionID: oldTarget.sessionID,
                    generation: oldTarget.generation,
                    targetID: oldTarget.targetID
                ))
            }
        }
    }

    private func startPolling() {
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now(), repeating: .milliseconds(25))
        source.setEventHandler { [weak self] in self?.poll() }
        lock.lock()
        guard target != nil else {
            lock.unlock()
            source.cancel()
            return
        }
        timer = source
        lock.unlock()
        source.resume()
    }

    private func poll() {
        lock.lock()
        guard !polling, let target, let controller, let sender else {
            lock.unlock()
            return
        }
        let needsActivation = connection.needsActivation
        polling = true
        lock.unlock()
        defer {
            lock.lock()
            polling = false
            lock.unlock()
        }
        if needsActivation {
            let activation = NativeInputMessage(
                type: .imeActivate,
                sessionID: target.sessionID,
                generation: target.generation,
                targetID: target.targetID
            )
            guard exchange(activation)?.accepted == true else {
                recordConnectionFailure(controller: controller, target: target)
                return
            }
            recordConnectionSuccess()
        }
        let request = NativeInputMessage(
            type: .imePoll,
            sessionID: target.sessionID,
            generation: target.generation,
            targetID: target.targetID
        )
        guard let operation = exchange(request) else {
            recordConnectionFailure(controller: controller, target: target)
            return
        }
        recordConnectionSuccess()
        guard operation.type != .imeIdle else {
            return
        }
        let accepted = DispatchQueue.main.sync {
            controller.applyBridgeOperation(operation, sender: sender)
        }
        _ = exchange(NativeInputMessage(
            type: .imeResult,
            reason: accepted ? nil : "operation_rejected",
            operationID: operation.operationID,
            accepted: accepted,
            sessionID: target.sessionID,
            generation: target.generation,
            targetID: target.targetID
        ))
    }

    private func recordConnectionSuccess() {
        lock.lock()
        connection.recordSuccess()
        lock.unlock()
    }

    private func recordConnectionFailure(
        controller: QwenInputController,
        target: NativeOperationTarget
    ) {
        lock.lock()
        let action = connection.recordFailure()
        lock.unlock()
        guard action == .failClosed else { return }
        DispatchQueue.main.async { [weak self, weak controller] in
            guard let self,
                  let controller,
                  let sender = self.currentSender(for: target) else { return }
            controller.bridgeConnectionLost(sender: sender)
        }
    }

    private func currentSender(
        for expectedTarget: NativeOperationTarget
    ) -> AnyObject? {
        lock.lock()
        defer { lock.unlock() }
        guard target == expectedTarget else { return nil }
        return sender
    }

    private func exchange(_ message: NativeInputMessage) -> NativeInputMessage? {
        do {
            let response = try AuthenticatedUnixSocketClient.exchange(
                FrameCodec.encode(message),
                socketURL: NativeRuntimePeer.runtimeDirectory().socketURL(),
                peerRequirement: NativeRuntimePeer.requirement(
                    for: "ai.qwenaudio.agent.inputbridge"
                )
            )
            return try FrameCodec.decode(NativeInputMessage.self, from: response)
        } catch {
            return nil
        }
    }
}
