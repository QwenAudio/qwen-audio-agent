import Foundation

public enum ValidationRejection: Equatable, Sendable {
    case unsupportedProtocolVersion
    case oversizedFrame
    case sessionMismatch
    case generationMismatch
    case targetMismatch
    case replayedOperation
    case nonMonotonicSequence
}

public enum ValidationResult: Equatable, Sendable {
    case accepted
    case rejected(ValidationRejection)
}

public struct ProtocolValidator: Sendable {
    public static let maximumEncodedByteCount = 65_536

    private var sessionID: UUID
    private var generation: UInt64
    private var targetID: UUID
    private let replayCapacity: Int
    private var acceptedSequence: UInt64 = 0
    private var acceptedOperationIDs: Set<UUID> = []
    private var operationOrder: [UUID] = []

    public init(
        sessionID: UUID,
        generation: UInt64,
        targetID: UUID,
        replayCapacity: Int = 256
    ) {
        self.sessionID = sessionID
        self.generation = generation
        self.targetID = targetID
        self.replayCapacity = max(1, replayCapacity)
    }

    public mutating func accept(
        metadata: NativeInputMetadata,
        encodedByteCount: Int
    ) -> ValidationResult {
        guard encodedByteCount <= Self.maximumEncodedByteCount else {
            return .rejected(.oversizedFrame)
        }
        guard metadata.protocolVersion == NativeInputCore.protocolVersion else {
            return .rejected(.unsupportedProtocolVersion)
        }
        guard metadata.sessionID == sessionID else {
            return .rejected(.sessionMismatch)
        }
        guard metadata.generation == generation else {
            return .rejected(.generationMismatch)
        }
        guard metadata.targetID == targetID else {
            return .rejected(.targetMismatch)
        }
        guard !acceptedOperationIDs.contains(metadata.operationID) else {
            return .rejected(.replayedOperation)
        }
        guard metadata.sequence > acceptedSequence else {
            return .rejected(.nonMonotonicSequence)
        }

        acceptedSequence = metadata.sequence
        acceptedOperationIDs.insert(metadata.operationID)
        operationOrder.append(metadata.operationID)
        if operationOrder.count > replayCapacity {
            let expired = operationOrder.removeFirst()
            acceptedOperationIDs.remove(expired)
        }
        return .accepted
    }

    public mutating func reset(
        sessionID: UUID,
        generation: UInt64,
        targetID: UUID
    ) {
        self.sessionID = sessionID
        self.generation = generation
        self.targetID = targetID
        acceptedSequence = 0
        acceptedOperationIDs.removeAll(keepingCapacity: true)
        operationOrder.removeAll(keepingCapacity: true)
    }
}
