import XCTest
@testable import QwenInputCore

final class BridgeConnectionStateTests: XCTestCase {
    func testRepeatedFailuresRequestOneFailClosedCleanupAndReconnect() {
        var state = BridgeConnectionState(failureThreshold: 3)

        XCTAssertTrue(state.needsActivation)
        XCTAssertEqual(state.recordFailure(), .none)
        XCTAssertEqual(state.recordFailure(), .none)
        XCTAssertEqual(state.recordFailure(), .failClosed)
        XCTAssertEqual(state.recordFailure(), .none)
        XCTAssertTrue(state.needsActivation)

        state.recordSuccess()
        XCTAssertFalse(state.needsActivation)
        XCTAssertEqual(state.recordFailure(), .none)
        XCTAssertTrue(state.needsActivation)
        state.recordSuccess()
        XCTAssertFalse(state.needsActivation)
    }

    func testARecoveredConnectionCanFailClosedAgain() {
        var state = BridgeConnectionState(failureThreshold: 1)

        XCTAssertEqual(state.recordFailure(), .failClosed)
        state.recordSuccess()
        XCTAssertEqual(state.recordFailure(), .failClosed)
    }
}
