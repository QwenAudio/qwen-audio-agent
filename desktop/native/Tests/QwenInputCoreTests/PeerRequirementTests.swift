import Foundation
import XCTest
@testable import QwenInputCore

final class PeerRequirementTests: XCTestCase {
    private let bridgeBundleID = "ai.qwenaudio.agent.inputbridge"
    private let inputBundleID = "ai.qwenaudio.agent.inputmethod"

    func testReleasePolicyAcceptsOnlyExactBundleTeamUserAndProtocol() {
        let policy = PeerRequirementPolicy(
            expectedBundleID: bridgeBundleID,
            expectedTeamID: "ABCDE12345",
            expectedEffectiveUserID: 501,
            allowAdHocDebugPeer: false
        )
        let valid = PeerIdentity(
            bundleID: bridgeBundleID,
            teamID: "ABCDE12345",
            effectiveUserID: 501,
            isAdHoc: false,
            protocolVersion: NativeInputCore.protocolVersion
        )

        XCTAssertEqual(policy.validate(valid), .accepted)
        XCTAssertEqual(
            policy.validate(copy(valid, bundleID: inputBundleID)),
            .rejected(.bundleMismatch)
        )
        XCTAssertEqual(
            policy.validate(copy(valid, teamID: "OTHER12345")),
            .rejected(.teamMismatch)
        )
        XCTAssertEqual(
            policy.validate(copy(valid, effectiveUserID: 502)),
            .rejected(.userMismatch)
        )
        XCTAssertEqual(
            policy.validate(copy(valid, protocolVersion: 2)),
            .rejected(.protocolMismatch)
        )
        XCTAssertEqual(
            policy.validate(PeerIdentity(
                bundleID: bridgeBundleID,
                teamID: nil,
                effectiveUserID: 501,
                isAdHoc: true,
                protocolVersion: NativeInputCore.protocolVersion
            )),
            .rejected(.adHocNotAllowed)
        )
    }

    func testDebugPolicyRequiresExplicitAdHocOptIn() {
        let peer = PeerIdentity(
            bundleID: inputBundleID,
            teamID: nil,
            effectiveUserID: 501,
            isAdHoc: true,
            protocolVersion: NativeInputCore.protocolVersion
        )
        let policy = PeerRequirementPolicy(
            expectedBundleID: inputBundleID,
            expectedTeamID: nil,
            expectedEffectiveUserID: 501,
            allowAdHocDebugPeer: true
        )

        XCTAssertEqual(policy.validate(peer), .accepted)
    }

    func testCodeSigningRequirementIsExactAndRejectsUnsafeIdentifiers() throws {
        XCTAssertEqual(
            try PeerCodeSigningRequirement.release(
                bundleID: bridgeBundleID,
                teamID: "ABCDE12345"
            ).value,
            "anchor apple generic and identifier \"ai.qwenaudio.agent.inputbridge\" "
                + "and certificate leaf[subject.OU] = \"ABCDE12345\""
        )
        XCTAssertEqual(
            try PeerCodeSigningRequirement.debugAdHoc(
                bundleID: inputBundleID
            ).value,
            "identifier \"ai.qwenaudio.agent.inputmethod\""
        )
        XCTAssertThrowsError(try PeerCodeSigningRequirement.release(
            bundleID: "bad\" or true",
            teamID: "ABCDE12345"
        ))
        XCTAssertThrowsError(try PeerCodeSigningRequirement.release(
            bundleID: bridgeBundleID,
            teamID: "bad team"
        ))
    }

    private func copy(
        _ identity: PeerIdentity,
        bundleID: String? = nil,
        teamID: String? = nil,
        effectiveUserID: uid_t? = nil,
        isAdHoc: Bool? = nil,
        protocolVersion: UInt16? = nil
    ) -> PeerIdentity {
        PeerIdentity(
            bundleID: bundleID ?? identity.bundleID,
            teamID: teamID ?? identity.teamID,
            effectiveUserID: effectiveUserID ?? identity.effectiveUserID,
            isAdHoc: isAdHoc ?? identity.isAdHoc,
            protocolVersion: protocolVersion ?? identity.protocolVersion
        )
    }
}
