import Foundation
import QwenInputCore

var peerServer: AuthenticatedUnixSocketServer?
var productionPeerServer: BridgePeerServer?
let broker = NativeOperationBroker()
var probeMode = false
var operationProbeMode = false
var operationProbeDirectory: SecureRuntimeDirectory?
#if DEBUG
if CommandLine.arguments.count == 3,
   CommandLine.arguments[1] == "--peer-probe-listen" {
    probeMode = true
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
if CommandLine.arguments.count == 3,
   CommandLine.arguments[1] == "--operation-probe-listen" {
    operationProbeMode = true
    operationProbeDirectory = SecureRuntimeDirectory(
        url: URL(fileURLWithPath: CommandLine.arguments[2])
    )
}
#endif

do {
    if !probeMode {
        let server = try BridgePeerServer(
            broker: broker,
            runtimeDirectory: operationProbeDirectory
                ?? NativeRuntimePeer.runtimeDirectory()
        )
        try server.start()
        productionPeerServer = server
    }
    let sourceAPI: InputSourceAPI
    #if DEBUG
    sourceAPI = operationProbeMode
        ? ProbeInputSourceAPI()
        : SystemInputSourceAPI()
    #else
    sourceAPI = SystemInputSourceAPI()
    #endif
    let runtime = BridgeRuntime(broker: broker, inputSourceAPI: sourceAPI)
    try runtime.run()
    runtime.emergencyStop(reason: "bridge_exit")
    peerServer?.stop()
    productionPeerServer?.stop()
} catch {
    peerServer?.stop()
    productionPeerServer?.stop()
    exit(EXIT_FAILURE)
}

#if DEBUG
private final class ProbeInputSourceAPI: InputSourceAPI {
    private var current = "probe.previous"
    func currentKeyboardSourceID() -> String? { current }
    func containsInputSource(id: String) -> Bool { true }
    func isInputSourceEnabled(id: String) -> Bool { true }
    func selectInputSource(id: String) -> Bool { current = id; return true }
    func registerInputSource(at url: URL) -> Bool { true }
}
#endif
