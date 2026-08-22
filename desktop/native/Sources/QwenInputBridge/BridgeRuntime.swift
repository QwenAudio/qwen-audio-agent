import Foundation
import QwenInputCore

enum BridgeRuntimeError: Error {
    case unsupportedDirection(NativeInputMessageType)
}

final class BridgeRuntime {
    let input: FileHandle
    let output: FileHandle
    let lifecycle: InputMethodLifecycle?
    let broker: NativeOperationBroker
    private var inputSourceCoordinator: InputSourceCoordinator

    init(
        input: FileHandle = .standardInput,
        output: FileHandle = .standardOutput,
        lifecycle: InputMethodLifecycle? = try? SystemInputMethodLifecycleFactory.make(),
        broker: NativeOperationBroker = NativeOperationBroker(),
        inputSourceAPI: InputSourceAPI = SystemInputSourceAPI()
    ) {
        self.input = input
        self.output = output
        self.lifecycle = lifecycle
        self.broker = broker
        inputSourceCoordinator = InputSourceCoordinator(
            qwenInputSourceID: "ai.qwenaudio.agent.inputmethod",
            api: inputSourceAPI
        )
    }

    func run() throws {
        try write(NativeInputMessage(type: .bridgeReady, state: .ready))
        var decoder = FrameStreamDecoder()

        while true {
            let chunk = input.availableData
            if chunk.isEmpty {
                try decoder.finish()
                return
            }
            do {
                for payload in try decoder.append(chunk) {
                    let request = try FrameCodec.decodePayload(
                        NativeInputMessage.self,
                        from: payload
                    )
                    let response = try response(to: request)
                    try write(response.message)
                    if response.shouldStop { return }
                }
            } catch {
                try? write(NativeInputMessage(
                    type: .bridgeError,
                    state: .error,
                    reason: String(describing: error)
                ))
                throw error
            }
        }
    }

    private func response(
        to request: NativeInputMessage
    ) throws -> (message: NativeInputMessage, shouldStop: Bool) {
        if request.operationID != nil,
           request.type.rawValue.hasPrefix("session.") {
            return (operationResponse(to: request), false)
        }
        let state: NativeSessionState
        let shouldStop: Bool
        switch request.type {
        case .sessionArm:
            state = .ready
            shouldStop = false
        case .sessionPartial:
            state = .transcribing
            shouldStop = false
        case .sessionFinal:
            state = .readyToSend
            shouldStop = false
        case .sessionCancel:
            state = .cancelled
            shouldStop = false
        case .sessionPause:
            state = .paused
            shouldStop = false
        case .sessionResume:
            state = .listening
            shouldStop = false
        case .sessionOperation:
            state = .transcribing
            shouldStop = false
        case .lifecycleStatus, .lifecycleInstall, .lifecycleRepair,
             .lifecycleUninstall:
            return (try lifecycleResponse(to: request), false)
        case .bridgeStop:
            state = .disabled
            shouldStop = true
        case .bridgeReady, .sessionState, .operationResult,
             .lifecycleResult, .imeActivate, .imeDeactivate, .imePoll,
             .imeResult, .imeIdle, .imeAck, .bridgeError:
            throw BridgeRuntimeError.unsupportedDirection(request.type)
        }
        return (
            NativeInputMessage(type: .sessionState, state: state),
            shouldStop
        )
    }

    private func operationResponse(
        to request: NativeInputMessage
    ) -> NativeInputMessage {
        guard let operationID = request.operationID else {
            return operationResult(request, accepted: false, reason: "missing_operation_id")
        }
        if request.type == .sessionArm {
            let source = inputSourceCoordinator.begin()
            switch source {
            case .selected, .alreadySelected:
                break
            default:
                return operationResult(
                    request,
                    accepted: false,
                    reason: "input_source_\(String(describing: source))"
                )
            }
            guard let target = broker.waitForTarget(timeout: 2.0) else {
                _ = inputSourceCoordinator.restore()
                return operationResult(
                    request,
                    accepted: false,
                    reason: "target_unavailable"
                )
            }
            let result = broker.arm(statusVisible: request.statusVisible == true)
            return NativeInputMessage(
                type: .operationResult,
                reason: result.reason,
                operationID: operationID,
                accepted: result.accepted,
                sessionID: target.sessionID,
                generation: target.generation,
                targetID: target.targetID
            )
        }

        if request.type == .sessionCancel {
            let result = broker.submitAndWait(request, timeout: 2.0)
            broker.cancel(reason: request.reason ?? "cancelled")
            _ = inputSourceCoordinator.restore()
            return operationResult(
                request,
                accepted: result.accepted,
                reason: result.reason
            )
        }
        let result = broker.submitAndWait(request, timeout: 2.0)
        if !result.accepted {
            broker.cancel(reason: result.reason ?? "operation_failed")
            _ = inputSourceCoordinator.restore()
        }
        return operationResult(
            request,
            accepted: result.accepted,
            reason: result.reason
        )
    }

    private func operationResult(
        _ request: NativeInputMessage,
        accepted: Bool,
        reason: String?
    ) -> NativeInputMessage {
        NativeInputMessage(
            type: .operationResult,
            reason: reason,
            operationID: request.operationID,
            accepted: accepted,
            sessionID: request.sessionID,
            generation: request.generation,
            targetID: request.targetID
        )
    }

    func emergencyStop(reason: String) {
        broker.cancel(reason: reason)
        _ = inputSourceCoordinator.restore()
    }

    private func lifecycleResponse(
        to request: NativeInputMessage
    ) throws -> NativeInputMessage {
        guard let lifecycle, let requestID = request.requestID else {
            throw InputMethodLifecycleError.embeddedBundleMissing
        }
        let action: String
        let status: InputMethodLifecycleStatus
        switch request.type {
        case .lifecycleStatus:
            action = "status"
            status = try lifecycle.status()
        case .lifecycleInstall:
            action = "install"
            status = try lifecycle.install()
        case .lifecycleRepair:
            action = "repair"
            status = try lifecycle.repair()
        case .lifecycleUninstall:
            action = "uninstall"
            status = try lifecycle.uninstall()
        default:
            throw BridgeRuntimeError.unsupportedDirection(request.type)
        }
        return NativeInputMessage(
            type: .lifecycleResult,
            requestID: requestID,
            action: action,
            installed: status.installed,
            registered: status.registered,
            enabled: status.enabled,
            version: status.version
        )
    }

    private func write(_ message: NativeInputMessage) throws {
        try output.write(contentsOf: FrameCodec.encode(message))
    }
}
