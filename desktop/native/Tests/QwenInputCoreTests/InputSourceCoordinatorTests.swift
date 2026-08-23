import Foundation
import XCTest
@testable import QwenInputCore

final class InputSourceCoordinatorTests: XCTestCase {
    private final class FakeAPI: InputSourceAPI {
        var currentID: String?
        var available: Set<String>
        var enabled: Set<String>
        var selectFailures: Set<String> = []
        var calls: [String] = []

        init(currentID: String?, available: Set<String>, enabled: Set<String>) {
            self.currentID = currentID
            self.available = available
            self.enabled = enabled
        }

        func currentKeyboardSourceID() -> String? {
            calls.append("current")
            return currentID
        }

        func containsInputSource(id: String) -> Bool {
            calls.append("find:\(id)")
            return available.contains(id)
        }

        func isInputSourceEnabled(id: String) -> Bool {
            calls.append("enabled:\(id)")
            return enabled.contains(id)
        }

        func selectInputSource(id: String) -> Bool {
            calls.append("select:\(id)")
            guard available.contains(id), !selectFailures.contains(id) else {
                return false
            }
            currentID = id
            return true
        }

        func registerInputSource(at url: URL) -> Bool {
            calls.append("register:\(url.lastPathComponent)")
            return true
        }
    }

    private let qwenID = "ai.qwenaudio.agent.inputmethod"
    private let previousID = "com.apple.keylayout.ABC"

    func testDefaultBeginRequiresExplicitUserSelectionWithoutChangingSource() {
        let api = FakeAPI(
            currentID: previousID,
            available: [previousID, qwenID],
            enabled: [previousID, qwenID]
        )
        var coordinator = InputSourceCoordinator(
            qwenInputSourceID: qwenID,
            api: api
        )

        XCTAssertEqual(coordinator.begin(), .selectionRequired)
        XCTAssertEqual(api.currentID, previousID)
        XCTAssertFalse(api.calls.contains("select:\(qwenID)"))
        XCTAssertNil(coordinator.recoveryInstruction)
    }

    func testRecordsCurrentSourceBeforeSelectingAndRestoresIt() {
        let api = FakeAPI(
            currentID: previousID,
            available: [previousID, qwenID],
            enabled: [previousID, qwenID]
        )
        var coordinator = InputSourceCoordinator(
            qwenInputSourceID: qwenID,
            api: api
        )

        XCTAssertEqual(
            coordinator.begin(selectIfNeeded: true),
            .selected(previousSourceID: previousID)
        )
        XCTAssertEqual(
            api.calls,
            ["current", "find:\(qwenID)", "enabled:\(qwenID)", "select:\(qwenID)"]
        )
        XCTAssertEqual(
            coordinator.recoveryInstruction,
            InputSourceRecoveryInstruction(
                previousSourceID: previousID,
                expectedCurrentSourceID: qwenID
            )
        )

        XCTAssertEqual(coordinator.restore(), .restored(sourceID: previousID))
        XCTAssertEqual(api.currentID, previousID)
        XCTAssertNil(coordinator.recoveryInstruction)
        XCTAssertEqual(coordinator.restore(), .alreadyRestored)
    }

    func testDisabledMissingOrFailedQwenSourceNeverCreatesRecoveryState() {
        let disabled = FakeAPI(
            currentID: previousID,
            available: [previousID, qwenID],
            enabled: [previousID]
        )
        var disabledCoordinator = InputSourceCoordinator(
            qwenInputSourceID: qwenID,
            api: disabled
        )
        XCTAssertEqual(disabledCoordinator.begin(), .qwenInputDisabled)
        XCTAssertNil(disabledCoordinator.recoveryInstruction)

        let failing = FakeAPI(
            currentID: previousID,
            available: [previousID, qwenID],
            enabled: [previousID, qwenID]
        )
        failing.selectFailures.insert(qwenID)
        var failingCoordinator = InputSourceCoordinator(
            qwenInputSourceID: qwenID,
            api: failing
        )
        XCTAssertEqual(
            failingCoordinator.begin(selectIfNeeded: true),
            .selectionFailed
        )
        XCTAssertNil(failingCoordinator.recoveryInstruction)
    }

    func testExternalSourceChangeFailsClosedWithoutOverwritingIt() {
        let externalID = "com.example.other"
        let api = FakeAPI(
            currentID: previousID,
            available: [previousID, qwenID, externalID],
            enabled: [previousID, qwenID, externalID]
        )
        var coordinator = InputSourceCoordinator(
            qwenInputSourceID: qwenID,
            api: api
        )
        XCTAssertEqual(
            coordinator.begin(selectIfNeeded: true),
            .selected(previousSourceID: previousID)
        )
        api.currentID = externalID

        XCTAssertEqual(
            coordinator.restore(),
            .currentSourceChanged(actualSourceID: externalID)
        )
        XCTAssertEqual(api.currentID, externalID)
        XCTAssertFalse(api.calls.contains("select:\(previousID)"))
    }

    func testMissingOrDisabledPreviousSourceIsNeverSelected() {
        let api = FakeAPI(
            currentID: previousID,
            available: [previousID, qwenID],
            enabled: [previousID, qwenID]
        )
        var coordinator = InputSourceCoordinator(
            qwenInputSourceID: qwenID,
            api: api
        )
        XCTAssertEqual(
            coordinator.begin(selectIfNeeded: true),
            .selected(previousSourceID: previousID)
        )
        api.enabled.remove(previousID)

        XCTAssertEqual(coordinator.restore(), .previousSourceUnavailable)
        XCTAssertEqual(api.currentID, qwenID)
        XCTAssertFalse(api.calls.contains("select:\(previousID)"))
    }
}
