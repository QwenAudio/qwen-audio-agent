import Foundation
import XCTest
@testable import QwenInputCore

final class ProtocolValidatorTests: XCTestCase {
    private let sessionID = UUID(uuidString: "10000000-0000-0000-0000-000000000001")!
    private let targetID = UUID(uuidString: "20000000-0000-0000-0000-000000000002")!

    private func operationID(_ suffix: Int) -> UUID {
        UUID(uuidString: String(
            format: "30000000-0000-0000-0000-%012d",
            suffix
        ))!
    }

    private func metadata(
        version: UInt16 = 1,
        sessionID: UUID? = nil,
        generation: UInt64 = 7,
        targetID: UUID? = nil,
        operation: Int,
        sequence: UInt64
    ) -> NativeInputMetadata {
        NativeInputMetadata(
            protocolVersion: version,
            sessionID: sessionID ?? self.sessionID,
            generation: generation,
            targetID: targetID ?? self.targetID,
            operationID: operationID(operation),
            sequence: sequence
        )
    }

    private func validator(replayCapacity: Int = 256) -> ProtocolValidator {
        ProtocolValidator(
            sessionID: sessionID,
            generation: 7,
            targetID: targetID,
            replayCapacity: replayCapacity
        )
    }

    func testAcceptsOnlyTheCurrentSessionTargetAndMonotonicSequence() {
        var validator = validator()

        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 1, sequence: 1),
                encodedByteCount: 512
            ),
            .accepted
        )
        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 2, sequence: 2),
                encodedByteCount: 512
            ),
            .accepted
        )
    }

    func testRejectsWrongVersionWithoutAdvancingTheSequence() {
        var validator = validator()

        XCTAssertEqual(
            validator.accept(
                metadata: metadata(
                    version: 2,
                    operation: 1,
                    sequence: 1
                ),
                encodedByteCount: 512
            ),
            .rejected(.unsupportedProtocolVersion)
        )
        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 1, sequence: 1),
                encodedByteCount: 512
            ),
            .accepted
        )
    }

    func testRejectsOversizedFramesWithoutConsumingTheOperation() {
        var validator = validator()

        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 1, sequence: 1),
                encodedByteCount: 65_537
            ),
            .rejected(.oversizedFrame)
        )
        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 1, sequence: 1),
                encodedByteCount: 65_536
            ),
            .accepted
        )
    }

    func testRejectsForeignSessionGenerationAndTarget() {
        let foreignSession = UUID(uuidString: "40000000-0000-0000-0000-000000000004")!
        let foreignTarget = UUID(uuidString: "50000000-0000-0000-0000-000000000005")!
        var validator = validator()

        XCTAssertEqual(
            validator.accept(
                metadata: metadata(
                    sessionID: foreignSession,
                    operation: 1,
                    sequence: 1
                ),
                encodedByteCount: 1
            ),
            .rejected(.sessionMismatch)
        )
        XCTAssertEqual(
            validator.accept(
                metadata: metadata(
                    generation: 6,
                    operation: 1,
                    sequence: 1
                ),
                encodedByteCount: 1
            ),
            .rejected(.generationMismatch)
        )
        XCTAssertEqual(
            validator.accept(
                metadata: metadata(
                    targetID: foreignTarget,
                    operation: 1,
                    sequence: 1
                ),
                encodedByteCount: 1
            ),
            .rejected(.targetMismatch)
        )
        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 1, sequence: 1),
                encodedByteCount: 1
            ),
            .accepted
        )
    }

    func testRejectsReplayAndOutOfOrderSequenceWithoutPoisoningNextMessage() {
        var validator = validator()
        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 1, sequence: 1),
                encodedByteCount: 1
            ),
            .accepted
        )

        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 1, sequence: 2),
                encodedByteCount: 1
            ),
            .rejected(.replayedOperation)
        )
        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 2, sequence: 1),
                encodedByteCount: 1
            ),
            .rejected(.nonMonotonicSequence)
        )
        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 2, sequence: 2),
                encodedByteCount: 1
            ),
            .accepted
        )
    }

    func testResetAcceptsAFreshGenerationAndDropsOldIdentity() {
        let nextTarget = UUID(uuidString: "60000000-0000-0000-0000-000000000006")!
        var validator = validator()
        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 1, sequence: 1),
                encodedByteCount: 1
            ),
            .accepted
        )

        validator.reset(
            sessionID: sessionID,
            generation: 8,
            targetID: nextTarget
        )

        XCTAssertEqual(
            validator.accept(
                metadata: metadata(
                    generation: 8,
                    targetID: nextTarget,
                    operation: 1,
                    sequence: 1
                ),
                encodedByteCount: 1
            ),
            .accepted
        )
        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 2, sequence: 2),
                encodedByteCount: 1
            ),
            .rejected(.generationMismatch)
        )
    }

    func testReplayWindowIsBounded() {
        var validator = validator(replayCapacity: 2)
        for operation in 1...3 {
            XCTAssertEqual(
                validator.accept(
                    metadata: metadata(
                        operation: operation,
                        sequence: UInt64(operation)
                    ),
                    encodedByteCount: 1
                ),
                .accepted
            )
        }

        XCTAssertEqual(
            validator.accept(
                metadata: metadata(operation: 1, sequence: 4),
                encodedByteCount: 1
            ),
            .accepted
        )
    }
}
