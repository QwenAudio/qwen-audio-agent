import Foundation
import InputMethodKit
import QwenInputCore

final class IMKTextClientAdapter: NativeTextClient {
    private let client: any IMKTextInput

    init?(_ value: Any?) {
        guard let client = value as? any IMKTextInput else { return nil }
        self.client = client
    }

    var selectedRange: NSRange {
        client.selectedRange()
    }

    var markedRange: NSRange {
        client.markedRange()
    }

    func setMarkedText(
        _ text: NSAttributedString,
        selectionRange: NSRange,
        replacementRange: NSRange
    ) {
        client.setMarkedText(
            text,
            selectionRange: selectionRange,
            replacementRange: replacementRange
        )
    }

    func insertText(_ text: Any, replacementRange: NSRange) {
        client.insertText(text, replacementRange: replacementRange)
    }

    var uniqueIdentifier: String? {
        client.uniqueClientIdentifierString()
    }
}
