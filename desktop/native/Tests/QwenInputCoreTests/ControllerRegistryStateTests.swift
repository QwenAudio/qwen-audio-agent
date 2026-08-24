import XCTest
@testable import QwenInputCore

final class ControllerRegistryStateTests: XCTestCase {
    func testActivationAndDeactivationAlwaysAdvanceGeneration() {
        var registry = ControllerRegistryState()

        let first = registry.activate(clientIdentifier: "client-a")
        XCTAssertEqual(first.generation, 1)
        XCTAssertEqual(first.clientIdentifier, "client-a")
        XCTAssertEqual(registry.current, first)

        XCTAssertTrue(registry.deactivate(targetID: first.targetID))
        XCTAssertEqual(registry.generation, 2)
        XCTAssertNil(registry.current)

        let second = registry.activate(clientIdentifier: "client-b")
        XCTAssertEqual(second.generation, 3)
        XCTAssertNotEqual(second.targetID, first.targetID)
        XCTAssertEqual(registry.current, second)
    }

    func testStaleControllerCannotDeactivateTheCurrentTarget() {
        var registry = ControllerRegistryState()
        let stale = registry.activate(clientIdentifier: "old")
        let current = registry.activate(clientIdentifier: "new")

        XCTAssertFalse(registry.deactivate(targetID: stale.targetID))
        XCTAssertEqual(registry.current, current)
        XCTAssertEqual(registry.generation, current.generation)

        XCTAssertTrue(registry.close(targetID: current.targetID))
        XCTAssertNil(registry.current)
        XCTAssertEqual(registry.generation, current.generation + 1)
    }
}
