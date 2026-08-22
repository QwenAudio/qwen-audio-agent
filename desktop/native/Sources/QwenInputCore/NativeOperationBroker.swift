import Foundation

public struct NativeOperationTarget: Equatable, Sendable {
    public let sessionID: String
    public let generation: UInt64
    public let targetID: String

    public init(sessionID: String, generation: UInt64, targetID: String) {
        self.sessionID = sessionID
        self.generation = generation
        self.targetID = targetID
    }
}

public struct NativeOperationResult: Equatable, Sendable {
    public let accepted: Bool
    public let reason: String?

    public init(accepted: Bool, reason: String?) {
        self.accepted = accepted
        self.reason = reason
    }
}

public final class NativeOperationBroker: @unchecked Sendable {
    private let condition = NSCondition()
    private var target: NativeOperationTarget?
    private var armed = false
    private var acceptedSequence: UInt64 = 0
    private var operationIDs: Set<String> = []
    private var queued: [NativeInputMessage] = []
    private var inFlight: Set<String> = []
    private var results: [String: NativeOperationResult] = [:]

    public init() {}

    public func activate(_ target: NativeOperationTarget) {
        condition.lock()
        if self.target != target { rejectOutstanding(reason: "target_lost") }
        self.target = target
        armed = false
        acceptedSequence = 0
        condition.broadcast()
        condition.unlock()
    }

    public func deactivate(_ target: NativeOperationTarget) {
        condition.lock()
        if self.target == target {
            self.target = nil
            armed = false
            rejectOutstanding(reason: "target_lost")
            condition.broadcast()
        }
        condition.unlock()
    }

    public func currentTarget() -> NativeOperationTarget? {
        condition.lock()
        defer { condition.unlock() }
        return target
    }

    public func hasActiveSession() -> Bool {
        condition.lock()
        defer { condition.unlock() }
        return armed
    }

    public func waitForTarget(timeout: TimeInterval) -> NativeOperationTarget? {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date(timeIntervalSinceNow: timeout)
        while target == nil && condition.wait(until: deadline) {}
        return target
    }

    public func arm(statusVisible: Bool) -> NativeOperationResult {
        condition.lock()
        defer { condition.unlock() }
        guard target != nil else {
            return NativeOperationResult(accepted: false, reason: "target_unavailable")
        }
        guard statusVisible else {
            return NativeOperationResult(accepted: false, reason: "status_hidden")
        }
        armed = true
        return NativeOperationResult(accepted: true, reason: nil)
    }

    public func enqueue(_ operation: NativeInputMessage) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        guard armed,
              let target,
              let operationID = operation.operationID,
              !operationID.isEmpty,
              !operationIDs.contains(operationID) else { return false }
        if let sequence = operation.sequence {
            guard sequence > acceptedSequence else { return false }
            acceptedSequence = sequence
        }
        operationIDs.insert(operationID)
        queued.append(NativeInputMessage(
            type: operation.type,
            text: operation.text,
            state: operation.state,
            reason: operation.reason,
            requestID: operation.requestID,
            action: operation.action,
            installed: operation.installed,
            registered: operation.registered,
            enabled: operation.enabled,
            version: operation.version,
            operationID: operation.operationID,
            accepted: operation.accepted,
            revision: operation.revision,
            sequence: operation.sequence,
            operation: operation.operation,
            target: operation.target,
            replacement: operation.replacement,
            statusVisible: operation.statusVisible,
            sessionID: target.sessionID,
            generation: target.generation,
            targetID: target.targetID
        ))
        condition.broadcast()
        return true
    }

    public func poll(for target: NativeOperationTarget) -> NativeInputMessage? {
        condition.lock()
        defer { condition.unlock() }
        guard self.target == target, armed, !queued.isEmpty else { return nil }
        let operation = queued.removeFirst()
        if let operationID = operation.operationID { inFlight.insert(operationID) }
        return operation
    }

    public func complete(
        operationID: String,
        accepted: Bool,
        reason: String?,
        target: NativeOperationTarget
    ) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        guard self.target == target, inFlight.remove(operationID) != nil else {
            return false
        }
        results[operationID] = NativeOperationResult(
            accepted: accepted,
            reason: reason
        )
        condition.broadcast()
        return true
    }

    public func takeResult(operationID: String) -> NativeOperationResult? {
        condition.lock()
        defer { condition.unlock() }
        return results.removeValue(forKey: operationID)
    }

    public func submitAndWait(
        _ operation: NativeInputMessage,
        timeout: TimeInterval
    ) -> NativeOperationResult {
        guard let operationID = operation.operationID, enqueue(operation) else {
            return NativeOperationResult(accepted: false, reason: "operation_rejected")
        }
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date(timeIntervalSinceNow: timeout)
        while results[operationID] == nil && condition.wait(until: deadline) {}
        if let result = results.removeValue(forKey: operationID) { return result }
        queued.removeAll { $0.operationID == operationID }
        inFlight.remove(operationID)
        return NativeOperationResult(accepted: false, reason: "operation_timeout")
    }

    public func cancel(reason: String) {
        condition.lock()
        armed = false
        rejectOutstanding(reason: reason)
        condition.broadcast()
        condition.unlock()
    }

    private func rejectOutstanding(reason: String) {
        for operation in queued {
            if let operationID = operation.operationID {
                results[operationID] = NativeOperationResult(
                    accepted: false,
                    reason: reason
                )
            }
        }
        for operationID in inFlight {
            results[operationID] = NativeOperationResult(
                accepted: false,
                reason: reason
            )
        }
        queued.removeAll()
        inFlight.removeAll()
    }
}
