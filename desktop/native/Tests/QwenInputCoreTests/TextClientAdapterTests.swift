import Foundation
import XCTest
@testable import QwenInputCore

final class TextClientAdapterTests: XCTestCase {
    private final class FakeClient: NativeTextClient {
        enum Call: Equatable {
            case setMarked(String, selection: NSRange, replacement: NSRange)
            case insert(String, replacement: NSRange)
        }

        private var selectedRanges: [NSRange]
        private var markedRanges: [NSRange]
        private(set) var calls: [Call] = []

        var selectedRange: NSRange {
            if selectedRanges.count > 1 {
                return selectedRanges.removeFirst()
            }
            return selectedRanges[0]
        }

        var markedRange: NSRange {
            if markedRanges.count > 1 {
                return markedRanges.removeFirst()
            }
            return markedRanges[0]
        }

        init(
            selectedRange: NSRange = NSRange(location: 3, length: 0),
            markedRange: NSRange = NSRange(location: NSNotFound, length: 0)
        ) {
            self.selectedRanges = [selectedRange]
            self.markedRanges = [markedRange]
        }

        init(selectedRanges: [NSRange], markedRanges: [NSRange]) {
            precondition(!selectedRanges.isEmpty)
            precondition(!markedRanges.isEmpty)
            self.selectedRanges = selectedRanges
            self.markedRanges = markedRanges
        }

        func setMarkedText(
            _ text: NSAttributedString,
            selectionRange: NSRange,
            replacementRange: NSRange
        ) {
            calls.append(.setMarked(
                text.string,
                selection: selectionRange,
                replacement: replacementRange
            ))
        }

        func insertText(_ text: Any, replacementRange: NSRange) {
            calls.append(.insert(String(describing: text), replacement: replacementRange))
        }
    }

    func testPartialUsesMarkedTextWithExactRanges() throws {
        let client = FakeClient()
        let effect = ClientTextEffect.setMarked(
            text: "A😀B",
            selection: NSRange(location: 4, length: 0),
            replacement: NSRange(location: NSNotFound, length: 0)
        )

        _ = try TextClientAdapter().apply(effect, to: client).get()

        XCTAssertEqual(client.calls, [
            .setMarked(
                "A😀B",
                selection: NSRange(location: 4, length: 0),
                replacement: NSRange(location: NSNotFound, length: 0)
            ),
        ])
    }

    func testFinalUsesOwnedRangeAndCancelRemovesCurrentComposition() throws {
        let marked = NSRange(location: 8, length: 5)
        let client = FakeClient(
            selectedRange: NSRange(location: 13, length: 0),
            markedRange: marked
        )
        let adapter = TextClientAdapter()

        _ = try adapter.apply(
            .commitMarked(text: "hello", replacement: marked),
            to: client
        ).get()
        _ = try adapter.apply(
            .removeMarked(replacement: marked),
            to: client
        ).get()

        XCTAssertEqual(client.calls, [
            .insert("hello", replacement: marked),
            .setMarked(
                "",
                selection: NSRange(location: 0, length: 0),
                replacement: marked
            ),
            .insert(
                "",
                replacement: NSRange(location: NSNotFound, length: NSNotFound)
            ),
        ])
    }

    func testOpaqueEffectsFailWithoutCallingTheClient() {
        let partialClient = FakeClient(
            selectedRange: NSRange(location: NSNotFound, length: 0),
            markedRange: NSRange(location: NSNotFound, length: 0)
        )
        XCTAssertEqual(
            TextClientAdapter().apply(
                .setMarked(
                    text: "opaque",
                    selection: NSRange(location: 6, length: 0),
                    replacement: NSRange(location: NSNotFound, length: 0)
                ),
                to: partialClient
            ),
            .failure(.unknownSelectedRange)
        )
        XCTAssertTrue(partialClient.calls.isEmpty)

        let finalClient = FakeClient(
            selectedRange: NSRange(location: NSNotFound, length: 0),
            markedRange: NSRange(location: NSNotFound, length: 6)
        )
        XCTAssertEqual(
            TextClientAdapter().apply(.insert(
                text: "final",
                replacement: NSRange(location: NSNotFound, length: 6)
            ), to: finalClient),
            .failure(.unknownSelectedRange)
        )
        XCTAssertTrue(finalClient.calls.isEmpty)
    }

    func testControllerRejectsOpaquePartialFinalAndCancelWithoutCallingClient() {
        let sessionID = UUID()
        let targetID = UUID()
        var partialLedger = SessionLedger(
            sessionID: sessionID,
            generation: 3,
            targetID: targetID
        )
        let partialClient = FakeClient(
            selectedRange: NSRange(location: NSNotFound, length: 0),
            markedRange: NSRange(location: NSNotFound, length: 0)
        )
        let partialResult = partialLedger.partial(
            text: "opaque",
            selectedRange: partialClient.selectedRange,
            clientMarkedRange: partialClient.markedRange,
            generation: 3,
            targetID: targetID
        )

        XCTAssertFalse(
            ClientTextOperationController().apply(partialResult, to: partialClient)
        )
        XCTAssertTrue(partialClient.calls.isEmpty)

        let opaque = NSRange(location: NSNotFound, length: 6)
        var finalLedger = SessionLedger(
            sessionID: sessionID,
            generation: 3,
            targetID: targetID
        )
        finalLedger.ownedMarkedRange = opaque
        let finalClient = FakeClient(
            selectedRange: NSRange(location: NSNotFound, length: 0),
            markedRange: opaque
        )
        let finalResult = finalLedger.final(
            text: "final",
            selectedRange: finalClient.selectedRange,
            clientMarkedRange: finalClient.markedRange,
            generation: 3,
            targetID: targetID
        )

        XCTAssertFalse(
            ClientTextOperationController().apply(finalResult, to: finalClient)
        )
        XCTAssertTrue(finalClient.calls.isEmpty)

        var cancelLedger = SessionLedger(
            sessionID: UUID(),
            generation: 3,
            targetID: targetID
        )
        cancelLedger.ownedMarkedRange = opaque
        let cancelClient = FakeClient(
            selectedRange: NSRange(location: NSNotFound, length: 0),
            markedRange: opaque
        )
        let cancelResult = cancelLedger.cancel(
            clientMarkedRange: cancelClient.markedRange,
            generation: 3,
            targetID: targetID
        )

        XCTAssertFalse(
            ClientTextOperationController().apply(cancelResult, to: cancelClient)
        )
        XCTAssertTrue(cancelClient.calls.isEmpty)
    }

    func testControllerRejectsOwnedFinalWhenRangeBecomesOpaqueBeforeInsert() throws {
        let targetID = UUID()
        let ownedRange = NSRange(location: 8, length: 5)
        var ledger = SessionLedger(
            sessionID: UUID(),
            generation: 3,
            targetID: targetID
        )
        _ = try ledger.partial(
            text: "draft",
            selectedRange: NSRange(location: 8, length: 0),
            clientMarkedRange: NSRange(location: NSNotFound, length: 0),
            generation: 3,
            targetID: targetID
        ).get()
        let client = FakeClient(
            selectedRanges: [NSRange(location: 13, length: 0)],
            markedRanges: [
                ownedRange,
                NSRange(location: NSNotFound, length: 0),
            ]
        )

        let applied = ClientTextOperationController().applyTransaction(
            to: &ledger,
            client: client,
            operation: { candidate in
                candidate.final(
                    text: "final",
                    selectedRange: client.selectedRange,
                    clientMarkedRange: client.markedRange,
                    generation: 3,
                    targetID: targetID
                )
            }
        )
        XCTAssertFalse(applied)

        XCTAssertTrue(client.calls.isEmpty)
        XCTAssertEqual(ledger.ownedMarkedRange, ownedRange)
        XCTAssertNil(ledger.latestOwnedFinalRange)
        XCTAssertNil(ledger.latestOwnedFinalText)
    }

    func testControllerKeepsOwnedRangeWhenCleanupBecomesOpaque() throws {
        let targetID = UUID()
        let ownedRange = NSRange(location: 8, length: 5)
        var ledger = SessionLedger(
            sessionID: UUID(),
            generation: 3,
            targetID: targetID
        )
        _ = try ledger.partial(
            text: "draft",
            selectedRange: NSRange(location: 8, length: 0),
            clientMarkedRange: NSRange(location: NSNotFound, length: 0),
            generation: 3,
            targetID: targetID
        ).get()
        let client = FakeClient(
            selectedRanges: [NSRange(location: 13, length: 0)],
            markedRanges: [
                ownedRange,
                NSRange(location: NSNotFound, length: 0),
            ]
        )

        let applied = ClientTextOperationController().applyTransaction(
            to: &ledger,
            client: client,
            operation: { candidate in
                candidate.cancel(
                    clientMarkedRange: client.markedRange,
                    generation: 3,
                    targetID: targetID
                )
            }
        )
        XCTAssertFalse(applied)

        XCTAssertTrue(client.calls.isEmpty)
        XCTAssertEqual(ledger.ownedMarkedRange, ownedRange)
    }

    func testControllerCommitsStableOwnedFinalAndAllowsOrdinaryEdit() throws {
        let targetID = UUID()
        let ownedRange = NSRange(location: 8, length: 5)
        var ledger = SessionLedger(
            sessionID: UUID(),
            generation: 3,
            targetID: targetID
        )
        _ = try ledger.partial(
            text: "draft",
            selectedRange: NSRange(location: 8, length: 0),
            clientMarkedRange: NSRange(location: NSNotFound, length: 0),
            generation: 3,
            targetID: targetID
        ).get()
        let finalClient = FakeClient(
            selectedRanges: [NSRange(location: 13, length: 0)],
            markedRanges: [ownedRange, ownedRange]
        )

        XCTAssertTrue(
            ClientTextOperationController().applyTransaction(
                to: &ledger,
                client: finalClient,
                operation: { candidate in
                    candidate.final(
                        text: "final",
                        selectedRange: finalClient.selectedRange,
                        clientMarkedRange: finalClient.markedRange,
                        generation: 3,
                        targetID: targetID
                    )
                }
            )
        )
        XCTAssertEqual(finalClient.calls, [
            .insert("final", replacement: ownedRange),
        ])
        XCTAssertNil(ledger.ownedMarkedRange)
        XCTAssertEqual(ledger.latestOwnedFinalText, "final")

        let editClient = FakeClient(
            selectedRange: NSRange(location: NSNotFound, length: 0),
            markedRange: NSRange(location: NSNotFound, length: 0)
        )
        XCTAssertTrue(
            ClientTextOperationController().applyTransaction(
                to: &ledger,
                client: editClient,
                operation: { candidate in
                    candidate.edit(
                        .replace(target: "final", replacement: "edited"),
                        generation: 3,
                        targetID: targetID
                    )
                }
            )
        )
        XCTAssertEqual(editClient.calls, [
            .insert("edited", replacement: ownedRange),
        ])
        XCTAssertEqual(ledger.latestOwnedFinalText, "edited")
    }

    func testControllerCommitsStandaloneFinalAtStableSelection() {
        let targetID = UUID()
        var ledger = SessionLedger(
            sessionID: UUID(),
            generation: 3,
            targetID: targetID
        )
        let client = FakeClient(
            selectedRanges: [
                NSRange(location: 10, length: 0),
                NSRange(location: 10, length: 0),
            ],
            markedRanges: [NSRange(location: NSNotFound, length: 0)]
        )

        XCTAssertTrue(
            ClientTextOperationController().applyTransaction(
                to: &ledger,
                client: client,
                operation: { candidate in
                    candidate.final(
                        text: "standalone",
                        selectedRange: client.selectedRange,
                        clientMarkedRange: client.markedRange,
                        generation: 3,
                        targetID: targetID
                    )
                }
            )
        )
        XCTAssertEqual(client.calls, [
            .insert(
                "standalone",
                replacement: NSRange(
                    location: NSNotFound,
                    length: NSNotFound
                )
            ),
        ])
        XCTAssertEqual(ledger.latestOwnedFinalText, "standalone")
        XCTAssertEqual(
            ledger.latestOwnedFinalRange,
            NSRange(location: 10, length: 10)
        )
    }

    func testPartialReusesAnEmptyCompositionLeftByTheClient() throws {
        let emptyComposition = NSRange(location: 8, length: 0)
        let client = FakeClient(
            selectedRange: NSRange(location: NSNotFound, length: 0),
            markedRange: emptyComposition
        )

        _ = try TextClientAdapter().apply(
            .setMarked(
                text: "next",
                selection: NSRange(location: 4, length: 0),
                replacement: NSRange(location: NSNotFound, length: 0)
            ),
            to: client
        ).get()

        XCTAssertEqual(client.calls, [
            .setMarked(
                "next",
                selection: NSRange(location: 4, length: 0),
                replacement: emptyComposition
            ),
        ])
    }

    func testMismatchedClientRangesFailWithoutCallingClient() {

        let foreignMarked = FakeClient(
            selectedRange: NSRange(location: 9, length: 0),
            markedRange: NSRange(location: 2, length: 3)
        )
        XCTAssertEqual(
            TextClientAdapter().apply(
                .removeMarked(replacement: NSRange(location: 4, length: 3)),
                to: foreignMarked
            ),
            .failure(.markedRangeMismatch)
        )
        XCTAssertTrue(foreignMarked.calls.isEmpty)
    }

    func testNoOpDoesNotTouchTheClient() throws {
        let client = FakeClient()

        _ = try TextClientAdapter().apply(.none, to: client).get()

        XCTAssertTrue(client.calls.isEmpty)
    }

    func testPhysicalKeyboardEventsAreNeverConsumed() {
        for state in NativeSessionState.allCases {
            XCTAssertFalse(
                InputEventPolicy.shouldConsumePhysicalKey(in: state),
                "physical key was consumed in \(state)"
            )
        }
    }
}
