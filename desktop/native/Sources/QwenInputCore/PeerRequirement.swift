import Darwin
import Foundation

public struct PeerIdentity: Equatable, Sendable {
    public let bundleID: String
    public let teamID: String?
    public let effectiveUserID: uid_t
    public let isAdHoc: Bool
    public let protocolVersion: UInt16

    public init(
        bundleID: String,
        teamID: String?,
        effectiveUserID: uid_t,
        isAdHoc: Bool,
        protocolVersion: UInt16
    ) {
        self.bundleID = bundleID
        self.teamID = teamID
        self.effectiveUserID = effectiveUserID
        self.isAdHoc = isAdHoc
        self.protocolVersion = protocolVersion
    }
}

public enum PeerRejection: Equatable, Sendable {
    case bundleMismatch
    case teamMismatch
    case userMismatch
    case protocolMismatch
    case adHocNotAllowed
}

public enum PeerValidationResult: Equatable, Sendable {
    case accepted
    case rejected(PeerRejection)
}

public struct PeerRequirementPolicy: Sendable {
    public let expectedBundleID: String
    public let expectedTeamID: String?
    public let expectedEffectiveUserID: uid_t
    public let allowAdHocDebugPeer: Bool

    public init(
        expectedBundleID: String,
        expectedTeamID: String?,
        expectedEffectiveUserID: uid_t,
        allowAdHocDebugPeer: Bool
    ) {
        self.expectedBundleID = expectedBundleID
        self.expectedTeamID = expectedTeamID
        self.expectedEffectiveUserID = expectedEffectiveUserID
        self.allowAdHocDebugPeer = allowAdHocDebugPeer
    }

    public func validate(_ peer: PeerIdentity) -> PeerValidationResult {
        guard peer.protocolVersion == NativeInputCore.protocolVersion else {
            return .rejected(.protocolMismatch)
        }
        guard peer.effectiveUserID == expectedEffectiveUserID else {
            return .rejected(.userMismatch)
        }
        guard peer.bundleID == expectedBundleID else {
            return .rejected(.bundleMismatch)
        }
        if peer.isAdHoc {
            guard allowAdHocDebugPeer else {
                return .rejected(.adHocNotAllowed)
            }
            guard expectedTeamID == nil, peer.teamID == nil else {
                return .rejected(.teamMismatch)
            }
            return .accepted
        }
        guard peer.teamID == expectedTeamID else {
            return .rejected(.teamMismatch)
        }
        return .accepted
    }
}

public struct PeerCodeSigningRequirement: Equatable, Sendable {
    public enum RequirementError: Error, Equatable, Sendable {
        case invalidBundleID
        case invalidTeamID
    }

    public let value: String

    public static func release(
        bundleID: String,
        teamID: String
    ) throws -> PeerCodeSigningRequirement {
        guard isSafeBundleID(bundleID) else {
            throw RequirementError.invalidBundleID
        }
        guard isSafeTeamID(teamID) else {
            throw RequirementError.invalidTeamID
        }
        return PeerCodeSigningRequirement(
            value: "anchor apple generic and identifier \"\(bundleID)\" "
                + "and certificate leaf[subject.OU] = \"\(teamID)\""
        )
    }

    public static func debugAdHoc(
        bundleID: String
    ) throws -> PeerCodeSigningRequirement {
        guard isSafeBundleID(bundleID) else {
            throw RequirementError.invalidBundleID
        }
        return PeerCodeSigningRequirement(value: "identifier \"\(bundleID)\"")
    }

    private static func isSafeBundleID(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        return value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == "-"
        }
    }

    private static func isSafeTeamID(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        return value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0)
        }
    }
}
