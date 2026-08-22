import Foundation
import Security

public struct CodeSignatureValidator: Sendable {
    private let requirement: PeerCodeSigningRequirement

    public init(requirement: PeerCodeSigningRequirement) {
        self.requirement = requirement
    }

    public func isValid(at url: URL) -> Bool {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(
            url as CFURL,
            SecCSFlags(),
            &code
        ) == errSecSuccess, let code else { return false }
        var requiredCode: SecRequirement?
        guard SecRequirementCreateWithString(
            requirement.value as CFString,
            SecCSFlags(),
            &requiredCode
        ) == errSecSuccess, let requiredCode else { return false }
        return SecStaticCodeCheckValidity(
            code,
            SecCSFlags(rawValue: (
                kSecCSCheckAllArchitectures | kSecCSStrictValidate
            )),
            requiredCode
        ) == errSecSuccess
    }
}
