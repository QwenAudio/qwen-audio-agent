import Foundation
import XCTest
@testable import QwenInputCore

final class TextClientAdapterTests: XCTestCase {
    private final class FakeClient: NativeTextClient {
        enum Call: Equatable {
            case setMarked(String, selection: NSRange, replacement: NSRange)
            case insert(String, replacement: NSRange)
        }

        var selectedRange: NSRange
        var markedRange: NSRange
        private(set) var calls: [Call] = []

        init(
            selectedRange: NSRange = NSRange(location: 3, length: 0),
            markedRange: NSRange = NSRange(location: NSNotFound, length: 0)
        ) {
            self.selectedRange = selectedRange
            self.markedRange = markedRange
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

    func testFinalAndRemoveUseInsertTextWithExactRanges() throws {
        let marked = NSRange(location: 8, length: 5)
        let client = FakeClient(
            selectedRange: NSRange(location: 13, length: 0),
            markedRange: marked
        )
        let adapter = TextClientAdapter()

        _ = try adapter.apply(
            .insert(text: "hello", replacement: marked),
            to: client
        ).get()
        _ = try adapter.apply(
            .removeMarked(replacement: marked),
            to: client
        ).get()

        XCTAssertEqual(client.calls, [
            .insert("hello", replacement: marked),
            .insert("", replacement: marked),
        ])
    }

    func testUnknownOrMismatchedClientRangesFailWithoutCallingClient() {
        let unknown = FakeClient(
            selectedRange: NSRange(location: NSNotFound, length: 0)
        )
        XCTAssertEqual(
            TextClientAdapter().apply(
                .setMarked(
                    text: "unsafe",
                    selection: NSRange(location: 6, length: 0),
                    replacement: NSRange(location: NSNotFound, length: 0)
                ),
                to: unknown
            ),
            .failure(.unknownSelectedRange)
        )
        XCTAssertTrue(unknown.calls.isEmpty)

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
