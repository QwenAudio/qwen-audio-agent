import Foundation
import QwenInputCore

final class BridgePeerServer {
    private let broker: NativeOperationBroker
    private let runtimeDirectory: SecureRuntimeDirectory
    private let server: AuthenticatedUnixSocketServer

    init(
        broker: NativeOperationBroker,
        runtimeDirectory: SecureRuntimeDirectory = NativeRuntimePeer.runtimeDirectory()
    ) throws {
        self.broker = broker
        self.runtimeDirectory = runtimeDirectory
        server = AuthenticatedUnixSocketServer(
            runtimeDirectory: runtimeDirectory,
            peerRequirement: try NativeRuntimePeer.requirement(
                for: "ai.qwenaudio.agent.inputmethod"
            ),
            handler: { [weak broker] request in
                guard let broker,
                      let message = try? FrameCodec.decode(
                        NativeInputMessage.self,
                        from: request
                      ),
                      let response = Self.handle(message, broker: broker)
                else { return nil }
                return try? FrameCodec.encode(response)
            }
        )
    }

    func start() throws { try server.start() }

    func stop() {
        server.stop()
        try? FileManager.default.removeItem(at: runtimeDirectory.url)
    }

    private static func handle(
        _ message: NativeInputMessage,
        broker: NativeOperationBroker
    ) -> NativeInputMessage? {
        guard let target = target(from: message) else { return nil }
        switch message.type {
        case .imeActivate:
            broker.activate(target)
            return ack(for: message, accepted: true)
        case .imeDeactivate:
            broker.deactivate(target)
            return ack(for: message, accepted: true)
        case .imePoll:
            return broker.poll(for: target) ?? NativeInputMessage(
                type: .imeIdle,
                sessionID: target.sessionID,
                generation: target.generation,
                targetID: target.targetID
            )
        case .imeResult:
            guard let operationID = message.operationID,
                  let accepted = message.accepted else { return nil }
            let completed = broker.complete(
                operationID: operationID,
                accepted: accepted,
                reason: message.reason,
                target: target
            )
            return ack(for: message, accepted: completed)
        default:
            return nil
        }
    }

    private static func target(
        from message: NativeInputMessage
    ) -> NativeOperationTarget? {
        guard let sessionID = message.sessionID, !sessionID.isEmpty,
              let generation = message.generation,
              let targetID = message.targetID, !targetID.isEmpty else {
            return nil
        }
        return NativeOperationTarget(
            sessionID: sessionID,
            generation: generation,
            targetID: targetID
        )
    }

    private static func ack(
        for message: NativeInputMessage,
        accepted: Bool
    ) -> NativeInputMessage {
        NativeInputMessage(
            type: .imeAck,
            operationID: message.operationID,
            accepted: accepted,
            sessionID: message.sessionID,
            generation: message.generation,
            targetID: message.targetID
        )
    }
}
