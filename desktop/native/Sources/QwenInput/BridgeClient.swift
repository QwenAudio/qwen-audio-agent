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

    func activate(
        controller: QwenInputController,
        sender: AnyObject,
        target: NativeOperationTarget
    ) {
        deactivate()
        self.controller = controller
        self.sender = sender
        self.target = target
        queue.async { [weak self] in
            guard let self else { return }
            let activation = NativeInputMessage(
                type: .imeActivate,
                sessionID: target.sessionID,
                generation: target.generation,
                targetID: target.targetID
            )
            guard self.exchange(activation)?.accepted == true else { return }
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
        polling = true
        lock.unlock()
        defer {
            lock.lock()
            polling = false
            lock.unlock()
        }
        let request = NativeInputMessage(
            type: .imePoll,
            sessionID: target.sessionID,
            generation: target.generation,
            targetID: target.targetID
        )
        guard let operation = exchange(request), operation.type != .imeIdle else {
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
