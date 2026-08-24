import Foundation
import XCTest
@testable import QwenInputCore

final class InputMethodLifecycleTests: XCTestCase {
    func testInstallValidatesThenAtomicallyInstallsAndRegistersWithoutEnabling() throws {
        let fileSystem = FakeInputMethodFileSystem()
        let registration = FakeInputMethodRegistration()
        let embedded = URL(fileURLWithPath: "/Applications/Qwen.app/Contents/Resources/native-input/Qwen Input.app")
        let installed = URL(fileURLWithPath: "/Users/test/Library/Input Methods/Qwen Input.app")
        fileSystem.inspections[embedded.path] = .valid(owner: 501)

        let lifecycle = makeLifecycle(
            fileSystem: fileSystem,
            registration: registration,
            embedded: embedded,
            installed: installed
        )
        let status = try lifecycle.install()

        XCTAssertEqual(fileSystem.installCalls, [[embedded.path, installed.path]])
        XCTAssertEqual(fileSystem.commitCalls, [installed.path])
        XCTAssertEqual(registration.calls, ["register:\(installed.path)"])
        XCTAssertTrue(status.installed)
        XCTAssertTrue(status.registered)
        XCTAssertFalse(status.enabled)
        XCTAssertEqual(status.version, "1.11.0")
    }

    func testInstallRejectsSymlinkWrongOwnerSignatureAndVersionBeforeMutation() {
        let invalid: [InputMethodArtifactInspection] = [
            .valid(owner: 0, symbolicLink: true),
            .valid(owner: 501, signatureValid: false),
            .valid(owner: 501, version: "0.9.0"),
            .valid(owner: 501, bundleID: "example.wrong.input"),
        ]
        for inspection in invalid {
            let fileSystem = FakeInputMethodFileSystem()
            let registration = FakeInputMethodRegistration()
            fileSystem.inspections["/embedded/Qwen Input.app"] = inspection
            let lifecycle = makeLifecycle(
                fileSystem: fileSystem,
                registration: registration,
                embedded: URL(fileURLWithPath: "/embedded/Qwen Input.app"),
                installed: URL(fileURLWithPath: "/installed/Qwen Input.app")
            )
            XCTAssertThrowsError(try lifecycle.install())
            XCTAssertTrue(fileSystem.installCalls.isEmpty)
            XCTAssertTrue(registration.calls.isEmpty)
        }
    }

    func testRegistrationFailureRollsBackAtomicReplacement() {
        let fileSystem = FakeInputMethodFileSystem()
        let registration = FakeInputMethodRegistration()
        let embedded = URL(fileURLWithPath: "/embedded/Qwen Input.app")
        let installed = URL(fileURLWithPath: "/installed/Qwen Input.app")
        fileSystem.inspections[embedded.path] = .valid(owner: 501)
        registration.registerResult = false
        let lifecycle = makeLifecycle(
            fileSystem: fileSystem,
            registration: registration,
            embedded: embedded,
            installed: installed
        )

        XCTAssertThrowsError(try lifecycle.install())
        XCTAssertEqual(fileSystem.rollbackCalls, [installed.path])
        XCTAssertTrue(fileSystem.commitCalls.isEmpty)
    }

    func testStatusFailsClosedForUnsafeInstalledBundle() throws {
        let fileSystem = FakeInputMethodFileSystem()
        let registration = FakeInputMethodRegistration()
        let installed = URL(fileURLWithPath: "/installed/Qwen Input.app")
        fileSystem.inspections[installed.path] = .valid(
            owner: 999,
            symbolicLink: true
        )
        registration.contains = true
        registration.enabled = true
        let lifecycle = makeLifecycle(
            fileSystem: fileSystem,
            registration: registration,
            installed: installed
        )

        let status = try lifecycle.status()
        XCTAssertFalse(status.installed)
        XCTAssertFalse(status.registered)
        XCTAssertFalse(status.enabled)
    }

    func testUninstallDisablesBeforeMovingBundleToTrash() throws {
        let fileSystem = FakeInputMethodFileSystem()
        let registration = FakeInputMethodRegistration()
        let installed = URL(fileURLWithPath: "/installed/Qwen Input.app")
        fileSystem.inspections[installed.path] = .valid(owner: 501)
        registration.contains = true
        registration.enabled = true
        let lifecycle = makeLifecycle(
            fileSystem: fileSystem,
            registration: registration,
            installed: installed
        )

        let status = try lifecycle.uninstall()
        XCTAssertEqual(registration.calls, ["disable"])
        XCTAssertEqual(fileSystem.trashCalls, [installed.path])
        XCTAssertFalse(status.installed)
        XCTAssertFalse(status.registered)
        XCTAssertFalse(status.enabled)
    }

    private func makeLifecycle(
        fileSystem: FakeInputMethodFileSystem,
        registration: FakeInputMethodRegistration,
        embedded: URL = URL(fileURLWithPath: "/embedded/Qwen Input.app"),
        installed: URL = URL(fileURLWithPath: "/installed/Qwen Input.app")
    ) -> InputMethodLifecycle {
        InputMethodLifecycle(
            embeddedBundleURL: embedded,
            installedBundleURL: installed,
            expectedBundleID: "ai.qwenaudio.agent.inputmethod",
            expectedVersion: "1.11.0",
            currentUserID: 501,
            fileSystem: fileSystem,
            registration: registration
        )
    }
}

private final class FakeInputMethodFileSystem: InputMethodLifecycleFileSystem {
    var inspections: [String: InputMethodArtifactInspection] = [:]
    var installCalls: [[String]] = []
    var commitCalls: [String] = []
    var rollbackCalls: [String] = []
    var trashCalls: [String] = []

    func inspect(at url: URL) -> InputMethodArtifactInspection? {
        inspections[url.path]
    }

    func installAtomically(from source: URL, to destination: URL) throws {
        installCalls.append([source.path, destination.path])
        inspections[destination.path] = inspections[source.path]
    }

    func rollbackInstall(at destination: URL) throws {
        rollbackCalls.append(destination.path)
        inspections[destination.path] = nil
    }

    func commitInstall(at destination: URL) throws {
        commitCalls.append(destination.path)
    }

    func moveToTrash(_ url: URL) throws {
        trashCalls.append(url.path)
        inspections[url.path] = nil
    }
}

private final class FakeInputMethodRegistration: InputMethodRegistration {
    var contains = false
    var enabled = false
    var registerResult = true
    var disableResult = true
    var calls: [String] = []

    func containsInputSource() -> Bool { contains }
    func isInputSourceEnabled() -> Bool { enabled }
    func registerInputSource(at url: URL) -> Bool {
        calls.append("register:\(url.path)")
        if registerResult { contains = true }
        return registerResult
    }
    func disableInputSource() -> Bool {
        calls.append("disable")
        if disableResult { enabled = false; contains = false }
        return disableResult
    }
}

private extension InputMethodArtifactInspection {
    static func valid(
        owner: UInt32,
        symbolicLink: Bool = false,
        signatureValid: Bool = true,
        version: String = "1.11.0",
        bundleID: String = "ai.qwenaudio.agent.inputmethod"
    ) -> InputMethodArtifactInspection {
        InputMethodArtifactInspection(
            symbolicLink: symbolicLink,
            ownerUserID: owner,
            bundleID: bundleID,
            version: version,
            signatureValid: signatureValid
        )
    }
}
