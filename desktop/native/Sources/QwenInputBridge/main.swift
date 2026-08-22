import Foundation
import QwenInputCore

var peerServer: AuthenticatedUnixSocketServer?
#if DEBUG
if CommandLine.arguments.count == 3,
   CommandLine.arguments[1] == "--peer-probe-listen" {
    do {
        let requirement = try PeerCodeSigningRequirement.debugAdHoc(
            bundleID: "ai.qwenaudio.agent.inputmethod"
        )
        let server = AuthenticatedUnixSocketServer(
            runtimeDirectory: SecureRuntimeDirectory(
                url: URL(fileURLWithPath: CommandLine.arguments[2])
            ),
            peerRequirement: requirement,
            handler: { request in
                guard (try? FrameCodec.decode(
                    NativeInputMessage.self,
                    from: request
                )) != nil else { return nil }
                return request
            }
        )
        try server.start()
        peerServer = server
    } catch {
        exit(EXIT_FAILURE)
    }
}
#endif

do {
    try BridgeRuntime().run()
    peerServer?.stop()
} catch {
    peerServer?.stop()
    exit(EXIT_FAILURE)
}
