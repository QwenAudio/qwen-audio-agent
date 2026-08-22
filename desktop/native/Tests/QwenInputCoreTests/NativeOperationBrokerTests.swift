import Foundation
import XCTest
@testable import QwenInputCore

final class NativeOperationBrokerTests: XCTestCase {
    func testRequiresVisibleActiveTargetBeforeArmAndRoutesCorrelatedOperation() {
        let broker = NativeOperationBroker()
        XCTAssertFalse(broker.arm(statusVisible: true).accepted)

        let target = NativeOperationTarget(
            sessionID: "session-1",
            generation: 3,
            targetID: "target-1"
        )
        broker.activate(target)
        XCTAssertFalse(broker.arm(statusVisible: false).accepted)
        XCTAssertTrue(broker.arm(statusVisible: true).accepted)

        let operation = NativeInputMessage(
            type: .sessionPartial,
            text: "A😀B",
            operationID: "operation-1",
            revision: 0,
            sequence: 1
        )
        XCTAssertTrue(broker.enqueue(operation))
        let routed = broker.poll(for: target)
        XCTAssertEqual(routed?.operationID, operation.operationID)
        XCTAssertEqual(routed?.text, operation.text)
        XCTAssertEqual(routed?.sessionID, target.sessionID)
        XCTAssertEqual(routed?.generation, target.generation)
        XCTAssertEqual(routed?.targetID, target.targetID)
        XCTAssertTrue(broker.complete(
            operationID: "operation-1",
            accepted: true,
            reason: nil,
            target: target
        ))
        XCTAssertEqual(broker.takeResult(operationID: "operation-1"),
                       NativeOperationResult(accepted: true, reason: nil))
        XCTAssertNil(broker.takeResult(operationID: "operation-1"))
    }

    func testTargetLossCancelsQueueAndRejectsLateResults() {
        let broker = NativeOperationBroker()
        let target = NativeOperationTarget(
            sessionID: "session-1",
            generation: 1,
            targetID: "target-1"
        )
        broker.activate(target)
        XCTAssertTrue(broker.arm(statusVisible: true).accepted)
        XCTAssertTrue(broker.enqueue(NativeInputMessage(
            type: .sessionFinal,
            text: "secret",
            operationID: "operation-1"
        )))

        broker.deactivate(target)
        XCTAssertNil(broker.poll(for: target))
        XCTAssertFalse(broker.complete(
            operationID: "operation-1",
            accepted: true,
            reason: nil,
            target: target
        ))
        XCTAssertEqual(broker.takeResult(operationID: "operation-1"),
                       NativeOperationResult(
                        accepted: false,
                        reason: "target_lost"
                       ))
    }

    func testRejectsWrongTargetReplayAndNonMonotonicSequence() {
        let broker = NativeOperationBroker()
        let target = NativeOperationTarget(
            sessionID: "session-1",
            generation: 1,
            targetID: "target-1"
        )
        broker.activate(target)
        XCTAssertTrue(broker.arm(statusVisible: true).accepted)
        XCTAssertTrue(broker.enqueue(NativeInputMessage(
            type: .sessionPartial,
            text: "one",
            operationID: "operation-1",
            sequence: 2
        )))
        XCTAssertFalse(broker.enqueue(NativeInputMessage(
            type: .sessionPartial,
            text: "replay",
            operationID: "operation-1",
            sequence: 3
        )))
        XCTAssertFalse(broker.enqueue(NativeInputMessage(
            type: .sessionPartial,
            text: "stale",
            operationID: "operation-2",
            sequence: 1
        )))
    }
}
