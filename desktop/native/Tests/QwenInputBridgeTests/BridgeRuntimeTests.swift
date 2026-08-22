import Foundation
import XCTest
import QwenInputCore

final class BridgeRuntimeTests: XCTestCase {
    func testRunRestoresPreviousInputSourceWhenFrameHandlingThrows() throws {
        let input = Pipe()
        let output = Pipe()
        let source = FakeInputSourceAPI()
        let broker = NativeOperationBroker()
        broker.activate(NativeOperationTarget(
            sessionID: "session-1",
            generation: 1,
            targetID: "target-1"
        ))
        let runtime = BridgeRuntime(
            input: input.fileHandleForReading,
            output: output.fileHandleForWriting,
            lifecycle: nil,
            broker: broker,
            inputSourceAPI: source
        )

        try input.fileHandleForWriting.write(contentsOf: FrameCodec.encode(
            NativeInputMessage(
                type: .sessionArm,
                operationID: "arm-1",
                statusVisible: true
            )
        ))
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
            try? input.fileHandleForWriting.write(contentsOf: Data([0, 0, 0, 0]))
            try? input.fileHandleForWriting.close()
        }

        XCTAssertThrowsError(try runtime.run())
        XCTAssertEqual(source.current, "probe.previous")
        XCTAssertEqual(source.selections, [
            "ai.qwenaudio.agent.inputmethod",
            "probe.previous",
        ])
    }

    func testRepairIsRejectedWithoutMutationWhileSessionIsArmed() throws {
        let input = Pipe()
        let output = Pipe()
        let source = FakeInputSourceAPI()
        let broker = NativeOperationBroker()
        broker.activate(NativeOperationTarget(
            sessionID: "session-1",
            generation: 1,
            targetID: "target-1"
        ))
        let fileSystem = FakeLifecycleFileSystem()
        let registration = FakeLifecycleRegistration()
        let lifecycle = InputMethodLifecycle(
            embeddedBundleURL: URL(fileURLWithPath: "/embedded/Qwen Input.app"),
            installedBundleURL: URL(fileURLWithPath: "/installed/Qwen Input.app"),
            expectedBundleID: "ai.qwenaudio.agent.inputmethod",
            expectedVersion: "1.11.0",
            currentUserID: 501,
            fileSystem: fileSystem,
            registration: registration
        )
        let runtime = BridgeRuntime(
            input: input.fileHandleForReading,
            output: output.fileHandleForWriting,
            lifecycle: lifecycle,
            broker: broker,
            inputSourceAPI: source
        )
        let messages = [
            NativeInputMessage(
                type: .sessionArm,
                operationID: "arm-1",
                statusVisible: true
            ),
            NativeInputMessage(type: .lifecycleRepair, requestID: "repair-1"),
            NativeInputMessage(type: .bridgeStop),
        ]
        for message in messages {
            try input.fileHandleForWriting.write(contentsOf: FrameCodec.encode(message))
        }
        try input.fileHandleForWriting.close()

        try runtime.run()
        XCTAssertTrue(fileSystem.installCalls.isEmpty)
        XCTAssertEqual(source.current, "probe.previous")
    }
}

private final class FakeInputSourceAPI: InputSourceAPI, @unchecked Sendable {
    var current = "probe.previous"
    var selections: [String] = []

    func currentKeyboardSourceID() -> String? { current }
    func containsInputSource(id: String) -> Bool { true }
    func isInputSourceEnabled(id: String) -> Bool { true }
    func selectInputSource(id: String) -> Bool {
        selections.append(id)
        current = id
        return true
    }
    func registerInputSource(at url: URL) -> Bool { true }
}

private final class FakeLifecycleFileSystem: InputMethodLifecycleFileSystem {
    var installCalls: [[String]] = []

    func inspect(at url: URL) -> InputMethodArtifactInspection? {
        InputMethodArtifactInspection(
            symbolicLink: false,
            ownerUserID: 501,
            bundleID: "ai.qwenaudio.agent.inputmethod",
            version: "1.11.0",
            signatureValid: true
        )
    }
    func installAtomically(from source: URL, to destination: URL) throws {
        installCalls.append([source.path, destination.path])
    }
    func commitInstall(at destination: URL) throws {}
    func rollbackInstall(at destination: URL) throws {}
    func moveToTrash(_ url: URL) throws {}
}

private final class FakeLifecycleRegistration: InputMethodRegistration {
    func containsInputSource() -> Bool { true }
    func isInputSourceEnabled() -> Bool { true }
    func registerInputSource(at url: URL) -> Bool { true }
    func disableInputSource() -> Bool { true }
}
