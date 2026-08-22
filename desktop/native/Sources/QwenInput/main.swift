import AppKit
import InputMethodKit
import QwenInputCore

#if DEBUG
if CommandLine.arguments.count == 3,
   CommandLine.arguments[1] == "--operation-probe" {
    let socketURL = URL(fileURLWithPath: CommandLine.arguments[2])
    let target = NativeOperationTarget(
        sessionID: "probe-session",
        generation: 1,
        targetID: "probe-target"
    )
    func exchange(_ message: NativeInputMessage) throws -> NativeInputMessage {
        let response = try AuthenticatedUnixSocketClient.exchange(
            FrameCodec.encode(message),
            socketURL: socketURL,
            peerRequirement: PeerCodeSigningRequirement.debugAdHoc(
                bundleID: "ai.qwenaudio.agent.inputbridge"
            )
        )
        return try FrameCodec.decode(NativeInputMessage.self, from: response)
    }
    do {
        let activated = try exchange(NativeInputMessage(
            type: .imeActivate,
            sessionID: target.sessionID,
            generation: target.generation,
            targetID: target.targetID
        ))
        guard activated.accepted == true else { exit(EXIT_FAILURE) }
        let deadline = Date(timeIntervalSinceNow: 5)
        var operation: NativeInputMessage?
        while Date() < deadline, operation == nil {
            let response = try exchange(NativeInputMessage(
                type: .imePoll,
                sessionID: target.sessionID,
                generation: target.generation,
                targetID: target.targetID
            ))
            if response.type != .imeIdle { operation = response }
            if operation == nil { Thread.sleep(forTimeInterval: 0.01) }
        }
        guard let operation, let operationID = operation.operationID else {
            exit(EXIT_FAILURE)
        }
        let result = try exchange(NativeInputMessage(
            type: .imeResult,
            operationID: operationID,
            accepted: true,
            sessionID: target.sessionID,
            generation: target.generation,
            targetID: target.targetID
        ))
        guard result.accepted == true else { exit(EXIT_FAILURE) }
        _ = try exchange(NativeInputMessage(
            type: .imeDeactivate,
            sessionID: target.sessionID,
            generation: target.generation,
            targetID: target.targetID
        ))
        exit(EXIT_SUCCESS)
    } catch {
        exit(EXIT_FAILURE)
    }
}
if CommandLine.arguments.count == 3,
   CommandLine.arguments[1] == "--peer-probe" {
    do {
        let requirement = try PeerCodeSigningRequirement.debugAdHoc(
            bundleID: "ai.qwenaudio.agent.inputbridge"
        )
        let request = try FrameCodec.encode(NativeInputMessage(
            type: .sessionArm
        ))
        let response = try AuthenticatedUnixSocketClient.exchange(
            request,
            socketURL: URL(fileURLWithPath: CommandLine.arguments[2]),
            peerRequirement: requirement
        )
        guard response == request else {
            exit(EXIT_FAILURE)
        }
        exit(EXIT_SUCCESS)
    } catch {
        exit(EXIT_FAILURE)
    }
}
#endif

guard
    let connectionName = Bundle.main.object(
        forInfoDictionaryKey: "InputMethodConnectionName"
    ) as? String,
    let bundleIdentifier = Bundle.main.bundleIdentifier
else {
    exit(EXIT_FAILURE)
}

_ = NativeInputCore.protocolVersion
let server = IMKServer(
    name: connectionName,
    bundleIdentifier: bundleIdentifier
)
withExtendedLifetime(server) {
    RunLoop.main.run()
}
