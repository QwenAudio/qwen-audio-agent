import Foundation

public struct SessionLedger: Sendable {
    public let sessionID: UUID
    public private(set) var generation: UInt64
    public private(set) var targetID: UUID
    public private(set) var ownedMarkedRange: NSRange?
    public private(set) var latestOwnedFinalRange: NSRange?
    public private(set) var latestOwnedFinalText: String?

    public init(sessionID: UUID, generation: UInt64, targetID: UUID) {
        self.sessionID = sessionID
        self.generation = generation
        self.targetID = targetID
    }

    public mutating func partial(
        text: String,
        selectedRange: NSRange,
        clientMarkedRange: NSRange,
        generation: UInt64,
        targetID: UUID
    ) -> Result<ClientTextEffect, LedgerError> {
        if let rejection = validate(generation: generation, targetID: targetID) {
            return .failure(rejection)
        }

        let replacement: NSRange
        let location: Int
        if let ownedMarkedRange {
            guard clientMarkedRange == ownedMarkedRange else {
                return .failure(.markedRangeMismatch)
            }
            replacement = ownedMarkedRange
            location = ownedMarkedRange.location
        } else {
            replacement = NSRange(location: NSNotFound, length: 0)
            location = selectedRange.location
        }

        let length = utf16Length(text)
        ownedMarkedRange = NSRange(location: location, length: length)
        return .success(.setMarked(
            text: text,
            selection: NSRange(location: length, length: 0),
            replacement: replacement
        ))
    }

    public mutating func final(
        text: String,
        selectedRange: NSRange,
        clientMarkedRange: NSRange,
        generation: UInt64,
        targetID: UUID
    ) -> Result<ClientTextEffect, LedgerError> {
        if let rejection = validate(generation: generation, targetID: targetID) {
            return .failure(rejection)
        }

        let replacement: NSRange
        let location: Int
        if let ownedMarkedRange {
            guard clientMarkedRange == ownedMarkedRange else {
                return .failure(.markedRangeMismatch)
            }
            replacement = ownedMarkedRange
            location = ownedMarkedRange.location
        } else {
            guard selectedRange.location != NSNotFound else {
                return .failure(.unknownClientRange)
            }
            replacement = NSRange(location: NSNotFound, length: NSNotFound)
            location = selectedRange.location
        }

        ownedMarkedRange = nil
        latestOwnedFinalText = text
        latestOwnedFinalRange = NSRange(
            location: location,
            length: utf16Length(text)
        )
        return .success(.insert(text: text, replacement: replacement))
    }

    public mutating func confirmMarkedRange(
        _ clientMarkedRange: NSRange
    ) -> Result<Void, LedgerError> {
        guard let ownedMarkedRange else {
            return .failure(.markedRangeMismatch)
        }
        guard ownedMarkedRange.location != NSNotFound else {
            return .failure(.unknownClientRange)
        }
        guard clientMarkedRange.location != NSNotFound,
              ownedMarkedRange == clientMarkedRange else {
            return .failure(.markedRangeMismatch)
        }
        return .success(())
    }

    public mutating func edit(
        _ operation: OwnedTextEdit,
        generation: UInt64,
        targetID: UUID
    ) -> Result<ClientTextEffect, LedgerError> {
        if let rejection = validate(generation: generation, targetID: targetID) {
            return .failure(rejection)
        }
        guard
            let latestOwnedFinalText,
            let latestOwnedFinalRange,
            latestOwnedFinalRange.location != NSNotFound
        else {
            return .failure(.noOwnedFinalText)
        }

        let target: String
        let replacement: String
        switch operation {
        case let .replace(editTarget, editReplacement):
            target = editTarget
            replacement = editReplacement
        case let .delete(editTarget):
            target = editTarget
            replacement = ""
        }
        guard !target.isEmpty else {
            return .failure(.editTargetNotFound)
        }

        let ownedText = latestOwnedFinalText as NSString
        let fullRange = NSRange(location: 0, length: ownedText.length)
        let first = ownedText.range(of: target, options: [], range: fullRange)
        guard first.location != NSNotFound else {
            return .failure(.editTargetNotFound)
        }

        let nextLocation = first.location + 1
        if nextLocation < ownedText.length {
            let remaining = NSRange(
                location: nextLocation,
                length: ownedText.length - nextLocation
            )
            if ownedText.range(of: target, options: [], range: remaining).location
                != NSNotFound {
                return .failure(.ambiguousEditTarget)
            }
        }

        let documentRange = NSRange(
            location: latestOwnedFinalRange.location + first.location,
            length: first.length
        )
        let updatedText = ownedText.replacingCharacters(
            in: first,
            with: replacement
        )
        self.latestOwnedFinalText = updatedText
        self.latestOwnedFinalRange = NSRange(
            location: latestOwnedFinalRange.location,
            length: utf16Length(updatedText)
        )
        return .success(.insert(text: replacement, replacement: documentRange))
    }

    public mutating func cancel(
        clientMarkedRange: NSRange,
        generation: UInt64,
        targetID: UUID
    ) -> Result<ClientTextEffect, LedgerError> {
        if let rejection = validate(generation: generation, targetID: targetID) {
            return .failure(rejection)
        }
        guard let ownedMarkedRange else {
            return .success(.none)
        }
        guard clientMarkedRange == ownedMarkedRange else {
            return .failure(.markedRangeMismatch)
        }
        self.ownedMarkedRange = nil
        return .success(.removeMarked(replacement: ownedMarkedRange))
    }

    public mutating func retarget(generation: UInt64, targetID: UUID) {
        self.generation = generation
        self.targetID = targetID
        ownedMarkedRange = nil
        latestOwnedFinalRange = nil
        latestOwnedFinalText = nil
    }

    private func validate(
        generation: UInt64,
        targetID: UUID
    ) -> LedgerError? {
        guard generation == self.generation else { return .staleGeneration }
        guard targetID == self.targetID else { return .targetMismatch }
        return nil
    }

    private func utf16Length(_ text: String) -> Int {
        (text as NSString).length
    }
}
