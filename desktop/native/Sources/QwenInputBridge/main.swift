import Darwin
import Foundation
import QwenInputCore

private final class BridgeShutdownCoordinator: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private var runtime: BridgeRuntime?
    private var peerServer: AuthenticatedUnixSocketServer?
    private var productionPeerServer: BridgePeerServer?

    func attach(
        runtime: BridgeRuntime,
        peerServer: AuthenticatedUnixSocketServer?,
        productionPeerServer: BridgePeerServer?
    ) {
        lock.lock()
        self.runtime = runtime
        self.peerServer = peerServer
        self.productionPeerServer = productionPeerServer
        lock.unlock()
    }

    func stop(reason: String) {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        stopped = true
        let runtime = runtime
        let peerServer = peerServer
        let productionPeerServer = productionPeerServer
        lock.unlock()
        runtime?.emergencyStop(reason: reason)
        peerServer?.stop()
        productionPeerServer?.stop()
    }
}

private func signalSource(
    _ signalNumber: Int32,
    shutdown: BridgeShutdownCoordinator
) -> DispatchSourceSignal {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(
        signal: signalNumber,
        queue: .global(qos: .userInitiated)
    )
    source.setEventHandler {
        shutdown.stop(reason: "signal_\(signalNumber)")
        exit(EXIT_SUCCESS)
    }
    source.resume()
    return source
}

private func reportStartupFailure(_ phase: String) {
    FileHandle.standardError.write(Data(
        "QwenInputBridge startup failed: \(phase)\n".utf8
    ))
}

var peerServer: AuthenticatedUnixSocketServer?
var productionPeerServer: BridgePeerServer?
let broker = NativeOperationBroker()
var probeMode = false
var operationProbeMode = false
var operationProbeDirectory: SecureRuntimeDirectory?
private let shutdown = BridgeShutdownCoordinator()
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
        reportStartupFailure("peer_probe")
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
    shutdown.attach(
        runtime: runtime,
        peerServer: peerServer,
        productionPeerServer: productionPeerServer
    )
    let terminationSignals = [
        signalSource(SIGTERM, shutdown: shutdown),
        signalSource(SIGINT, shutdown: shutdown),
    ]
    try runtime.run()
    withExtendedLifetime(terminationSignals) {}
    shutdown.stop(reason: "bridge_exit")
} catch {
    shutdown.stop(reason: "bridge_error")
    reportStartupFailure("runtime")
    exit(EXIT_FAILURE)
}

#if DEBUG
private final class ProbeInputSourceAPI: InputSourceAPI {
    private var current = "ai.qwenaudio.agent.inputmethod"
    func currentKeyboardSourceID() -> String? { current }
    func containsInputSource(id: String) -> Bool { true }
    func isInputSourceEnabled(id: String) -> Bool { true }
    func selectInputSource(id: String) -> Bool { current = id; return true }
    func registerInputSource(at url: URL) -> Bool { true }
}
#endif
