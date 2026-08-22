import Foundation

public struct NativeInputEnvelope<Payload: Codable & Sendable>: Codable, Sendable {
    public let protocolVersion: UInt16
    public let sessionID: UUID
    public let generation: UInt64
    public let targetID: UUID
    public let operationID: UUID
    public let sequence: UInt64
    public let payload: Payload

    public init(
        protocolVersion: UInt16 = NativeInputCore.protocolVersion,
        sessionID: UUID,
        generation: UInt64,
        targetID: UUID,
        operationID: UUID,
        sequence: UInt64,
        payload: Payload
    ) {
        self.protocolVersion = protocolVersion
        self.sessionID = sessionID
        self.generation = generation
        self.targetID = targetID
        self.operationID = operationID
        self.sequence = sequence
        self.payload = payload
    }

    public var metadata: NativeInputMetadata {
        NativeInputMetadata(
            protocolVersion: protocolVersion,
            sessionID: sessionID,
            generation: generation,
            targetID: targetID,
            operationID: operationID,
            sequence: sequence
        )
    }
}
public struct NativeInputMetadata: Codable, Equatable, Sendable {
    public let protocolVersion: UInt16
    public let sessionID: UUID
    public let generation: UInt64
    public let targetID: UUID
    public let operationID: UUID
    public let sequence: UInt64

    public init(
        protocolVersion: UInt16,
        sessionID: UUID,
        generation: UInt64,
        targetID: UUID,
        operationID: UUID,
        sequence: UInt64
    ) {
        self.protocolVersion = protocolVersion
        self.sessionID = sessionID
        self.generation = generation
        self.targetID = targetID
        self.operationID = operationID
        self.sequence = sequence
    }
}
