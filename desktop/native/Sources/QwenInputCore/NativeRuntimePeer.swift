import Foundation
import Security

public enum NativeRuntimePeerError: Error, Sendable {
    case missingTeamIdentifier
}

public enum NativeRuntimePeer {
    public static func runtimeDirectory() -> SecureRuntimeDirectory {
        SecureRuntimeDirectory(url: FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "ai.qwenaudio.agent.native-input-\(geteuid())",
                isDirectory: true
            ))
    }

    public static func requirement(
        for bundleID: String
    ) throws -> PeerCodeSigningRequirement {
        #if DEBUG
        return try .debugAdHoc(bundleID: bundleID)
        #else
        guard let teamID = currentTeamIdentifier() else {
            throw NativeRuntimePeerError.missingTeamIdentifier
        }
        return try .release(bundleID: bundleID, teamID: teamID)
        #endif
    }

    private static func currentTeamIdentifier() -> String? {
        let executable = Bundle.main.executableURL
            ?? URL(fileURLWithPath: CommandLine.arguments[0])
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(
            executable as CFURL,
            SecCSFlags(),
            &code
        ) == errSecSuccess, let code else { return nil }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(
            code,
            SecCSFlags(),
            &information
        ) == errSecSuccess,
              let values = information as? [CFString: Any]
        else { return nil }
        return values[kSecCodeInfoTeamIdentifier] as? String
    }
}
