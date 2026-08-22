import Foundation
import Security

public enum DynamicPeerCodeValidator {
    public static func validate(
        processID: pid_t,
        requirement: PeerCodeSigningRequirement
    ) -> Bool {
        let attributes = NSDictionary(
            object: NSNumber(value: processID),
            forKey: (kSecGuestAttributePid as String) as NSString
        )
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(
            nil,
            attributes,
            SecCSFlags(),
            &code
        ) == errSecSuccess, let code else {
            return false
        }

        var compiledRequirement: SecRequirement?
        guard SecRequirementCreateWithString(
            requirement.value as CFString,
            SecCSFlags(),
            &compiledRequirement
        ) == errSecSuccess, let compiledRequirement else {
            return false
        }
        return SecCodeCheckValidity(
            code,
            SecCSFlags(),
            compiledRequirement
        ) == errSecSuccess
    }
}
