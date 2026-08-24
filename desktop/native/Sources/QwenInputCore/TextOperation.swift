import Foundation

public enum OwnedTextEdit: Equatable, Sendable {
    case replace(target: String, replacement: String)
    case delete(target: String)
}
public enum ClientTextEffect: Equatable, Sendable {
    case setMarked(text: String, selection: NSRange, replacement: NSRange)
    case commitMarked(text: String, replacement: NSRange)
    case commitSelection(text: String, expectedSelection: NSRange)
    case insert(text: String, replacement: NSRange)
    case removeMarked(replacement: NSRange)
    case none
}

public enum LedgerError: Error, Equatable, Sendable {
    case staleGeneration
    case targetMismatch
    case unknownClientRange
    case markedRangeMismatch
    case noOwnedFinalText
    case editTargetNotFound
    case ambiguousEditTarget
}
