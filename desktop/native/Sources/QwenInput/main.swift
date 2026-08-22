import AppKit
import InputMethodKit
import QwenInputCore

#if DEBUG
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
