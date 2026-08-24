import Foundation

public struct ControllerTargetToken: Equatable, Sendable {
    public let generation: UInt64
    public let targetID: UUID
    public let clientIdentifier: String

    public init(
        generation: UInt64,
        targetID: UUID,
        clientIdentifier: String
    ) {
        self.generation = generation
        self.targetID = targetID
        self.clientIdentifier = clientIdentifier
    }
}

public struct ControllerRegistryState: Sendable {
    public private(set) var generation: UInt64 = 0
    public private(set) var current: ControllerTargetToken?

    public init() {}

    @discardableResult
    public mutating func activate(
        clientIdentifier: String,
        targetID: UUID = UUID()
    ) -> ControllerTargetToken {
        generation &+= 1
        let token = ControllerTargetToken(
            generation: generation,
            targetID: targetID,
            clientIdentifier: clientIdentifier
        )
        current = token
        return token
    }

    @discardableResult
    public mutating func deactivate(targetID: UUID) -> Bool {
        guard current?.targetID == targetID else { return false }
        generation &+= 1
        current = nil
        return true
    }

    @discardableResult
    public mutating func close(targetID: UUID) -> Bool {
        deactivate(targetID: targetID)
    }
}
