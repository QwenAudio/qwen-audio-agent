import Foundation

public protocol NativeTextClient: AnyObject {
    var selectedRange: NSRange { get }
    var markedRange: NSRange { get }

    func setMarkedText(
        _ text: NSAttributedString,
        selectionRange: NSRange,
        replacementRange: NSRange
    )

    func insertText(_ text: Any, replacementRange: NSRange)
}

public enum TextClientError: Error, Equatable, Sendable {
    case unknownSelectedRange
    case markedRangeMismatch
    case invalidSelectionRange
}

public struct TextClientAdapter: Sendable {
    public init() {}

    @discardableResult
    public func apply(
        _ effect: ClientTextEffect,
        to client: NativeTextClient
    ) -> Result<Bool, TextClientError> {
        switch effect {
        case let .setMarked(text, selection, replacement):
            guard isValidSelection(selection, in: text) else {
                return .failure(.invalidSelectionRange)
            }
            if replacement.location == NSNotFound {
                guard client.selectedRange.location != NSNotFound else {
                    return .failure(.unknownSelectedRange)
                }
                guard client.markedRange.location == NSNotFound else {
                    return .failure(.markedRangeMismatch)
                }
            } else if client.markedRange != replacement {
                return .failure(.markedRangeMismatch)
            }
            client.setMarkedText(
                NSAttributedString(string: text),
                selectionRange: selection,
                replacementRange: replacement
            )
            return .success(true)

        case let .insert(text, replacement):
            if replacement.location == NSNotFound {
                guard client.selectedRange.location != NSNotFound else {
                    return .failure(.unknownSelectedRange)
                }
            } else if client.markedRange.location != NSNotFound,
                      client.markedRange != replacement {
                return .failure(.markedRangeMismatch)
            }
            client.insertText(text, replacementRange: replacement)
            return .success(true)

        case let .removeMarked(replacement):
            guard replacement.location != NSNotFound,
                  client.markedRange == replacement else {
                return .failure(.markedRangeMismatch)
            }
            client.insertText("", replacementRange: replacement)
            return .success(true)

        case .none:
            return .success(false)
        }
    }

    private func isValidSelection(_ selection: NSRange, in text: String) -> Bool {
        guard selection.location != NSNotFound else { return false }
        let length = (text as NSString).length
        return selection.location <= length
            && selection.length <= length - selection.location
    }
}

public enum InputEventPolicy {
    public static func shouldConsumePhysicalKey(
        in state: NativeSessionState
    ) -> Bool {
        _ = state
        return false
    }
}
