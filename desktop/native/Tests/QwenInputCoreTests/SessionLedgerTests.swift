import Foundation
import XCTest
@testable import QwenInputCore

final class SessionLedgerTests: XCTestCase {
    private let sessionID = UUID(uuidString: "70000000-0000-0000-0000-000000000007")!
    private let targetID = UUID(uuidString: "80000000-0000-0000-0000-000000000008")!

    private func ledger() -> SessionLedger {
        SessionLedger(sessionID: sessionID, generation: 3, targetID: targetID)
    }

    private func range(_ location: Int, _ length: Int) -> NSRange {
        NSRange(location: location, length: length)
    }

    func testPartialAndFinalUseUTF16Ranges() throws {
        var ledger = ledger()

        XCTAssertEqual(
            try ledger.partial(
                text: "A😀B",
                selectedRange: range(4, 0),
                clientMarkedRange: range(NSNotFound, 0),
                generation: 3,
                targetID: targetID
            ).get(),
            .setMarked(
                text: "A😀B",
                selection: range(4, 0),
                replacement: range(NSNotFound, 0)
            )
        )
        XCTAssertEqual(ledger.ownedMarkedRange, range(4, 4))

        XCTAssertEqual(
            try ledger.final(
                text: "A😀B",
                selectedRange: range(8, 0),
                clientMarkedRange: range(4, 4),
                generation: 3,
                targetID: targetID
            ).get(),
            .insert(text: "A😀B", replacement: range(4, 4))
        )
        XCTAssertNil(ledger.ownedMarkedRange)
        XCTAssertEqual(ledger.latestOwnedFinalRange, range(4, 4))
        XCTAssertEqual(ledger.latestOwnedFinalText, "A😀B")
    }

    func testPartialCanReplaceOnlyTheOwnedMarkedRange() throws {
        var ledger = ledger()
        _ = try ledger.partial(
            text: "hello",
            selectedRange: range(2, 0),
            clientMarkedRange: range(NSNotFound, 0),
            generation: 3,
            targetID: targetID
        ).get()

        XCTAssertEqual(
            try ledger.partial(
                text: "hi",
                selectedRange: range(7, 0),
                clientMarkedRange: range(2, 5),
                generation: 3,
                targetID: targetID
            ).get(),
            .setMarked(
                text: "hi",
                selection: range(2, 0),
                replacement: range(2, 5)
            )
        )
        XCTAssertEqual(ledger.ownedMarkedRange, range(2, 2))

        XCTAssertThrowsError(try ledger.partial(
            text: "unsafe",
            selectedRange: range(4, 0),
            clientMarkedRange: range(0, 2),
            generation: 3,
            targetID: targetID
        ).get()) { error in
            XCTAssertEqual(error as? LedgerError, .markedRangeMismatch)
        }
        XCTAssertEqual(ledger.ownedMarkedRange, range(2, 2))
    }

    func testReplaceAndDeleteStayInsideOneLatestOwnedFinalMatch() throws {
        var ledger = ledger()
        _ = try ledger.final(
            text: "hello world",
            selectedRange: range(10, 0),
            clientMarkedRange: range(NSNotFound, 0),
            generation: 3,
            targetID: targetID
        ).get()

        XCTAssertEqual(
            try ledger.edit(
                .replace(target: "world", replacement: "earth"),
                generation: 3,
                targetID: targetID
            ).get(),
            .insert(text: "earth", replacement: range(16, 5))
        )
        XCTAssertEqual(ledger.latestOwnedFinalText, "hello earth")
        XCTAssertEqual(ledger.latestOwnedFinalRange, range(10, 11))

        XCTAssertEqual(
            try ledger.edit(
                .delete(target: "hello "),
                generation: 3,
                targetID: targetID
            ).get(),
            .insert(text: "", replacement: range(10, 6))
        )
        XCTAssertEqual(ledger.latestOwnedFinalText, "earth")
        XCTAssertEqual(ledger.latestOwnedFinalRange, range(10, 5))
    }

    func testAmbiguousAbsentAndUnknownRangesDoNotMutateTheLedger() throws {
        var activeLedger = ledger()
        _ = try activeLedger.final(
            text: "x x",
            selectedRange: range(5, 0),
            clientMarkedRange: range(NSNotFound, 0),
            generation: 3,
            targetID: targetID
        ).get()

        XCTAssertThrowsError(try activeLedger.edit(
            .replace(target: "x", replacement: "y"),
            generation: 3,
            targetID: targetID
        ).get()) { error in
            XCTAssertEqual(error as? LedgerError, .ambiguousEditTarget)
        }
        XCTAssertThrowsError(try activeLedger.edit(
            .delete(target: "z"),
            generation: 3,
            targetID: targetID
        ).get()) { error in
            XCTAssertEqual(error as? LedgerError, .editTargetNotFound)
        }
        XCTAssertEqual(activeLedger.latestOwnedFinalText, "x x")

        var unknown = ledger()
        XCTAssertThrowsError(try unknown.final(
            text: "never inserted",
            selectedRange: range(NSNotFound, 0),
            clientMarkedRange: range(NSNotFound, 0),
            generation: 3,
            targetID: targetID
        ).get()) { error in
            XCTAssertEqual(error as? LedgerError, .unknownClientRange)
        }
        XCTAssertNil(unknown.latestOwnedFinalRange)
    }

    func testStaleGenerationOrTargetCannotProduceAnEffect() throws {
        let staleTarget = UUID(uuidString: "90000000-0000-0000-0000-000000000009")!
        var ledger = ledger()

        XCTAssertThrowsError(try ledger.partial(
            text: "stale",
            selectedRange: range(0, 0),
            clientMarkedRange: range(NSNotFound, 0),
            generation: 2,
            targetID: targetID
        ).get()) { error in
            XCTAssertEqual(error as? LedgerError, .staleGeneration)
        }
        XCTAssertThrowsError(try ledger.partial(
            text: "foreign",
            selectedRange: range(0, 0),
            clientMarkedRange: range(NSNotFound, 0),
            generation: 3,
            targetID: staleTarget
        ).get()) { error in
            XCTAssertEqual(error as? LedgerError, .targetMismatch)
        }
        XCTAssertNil(ledger.ownedMarkedRange)
    }

    func testRetargetInvalidatesPendingStateAndCancelNeverRollsBackFinalText() throws {
        let nextTarget = UUID(uuidString: "A0000000-0000-0000-0000-00000000000A")!
        var ledger = ledger()
        _ = try ledger.final(
            text: "committed",
            selectedRange: range(0, 0),
            clientMarkedRange: range(NSNotFound, 0),
            generation: 3,
            targetID: targetID
        ).get()
        _ = try ledger.partial(
            text: "temporary",
            selectedRange: range(9, 0),
            clientMarkedRange: range(NSNotFound, 0),
            generation: 3,
            targetID: targetID
        ).get()

        XCTAssertEqual(
            ledger.cancel(
                clientMarkedRange: range(9, 9),
                generation: 3,
                targetID: targetID
            ),
            .success(.removeMarked(replacement: range(9, 9)))
        )
        XCTAssertEqual(ledger.latestOwnedFinalText, "committed")
        XCTAssertEqual(ledger.latestOwnedFinalRange, range(0, 9))

        ledger.retarget(generation: 4, targetID: nextTarget)
        XCTAssertNil(ledger.ownedMarkedRange)
        XCTAssertNil(ledger.latestOwnedFinalRange)
        XCTAssertNil(ledger.latestOwnedFinalText)
    }
}
