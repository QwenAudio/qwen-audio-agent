import Foundation

public enum GatewayInvitationCodec {
    private static let allowedKeys: Set<String> = [
        "version", "gateway_url", "pairing_code", "expires_at",
    ]

    public static func decode(_ deepLink: URL, now: Date = Date()) throws -> GatewayInvitation {
        guard deepLink.scheme == "qwaudio",
              deepLink.host == "connect",
              let components = URLComponents(url: deepLink, resolvingAgainstBaseURL: false),
              let encodedFragment = components.percentEncodedFragment,
              let fragment = encodedFragment.removingPercentEncoding,
              let data = fragment.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == allowedKeys,
              let version = object["version"] as? Int,
              let gatewayURLValue = object["gateway_url"] as? String,
              let gatewayURL = URL(string: gatewayURLValue),
              let pairingCode = object["pairing_code"] as? String,
              let expiresNumber = object["expires_at"] as? NSNumber else {
            throw GatewayMobileError.invalidInvitation
        }
        let invitation = try GatewayInvitation(
            version: version,
            gatewayURL: gatewayURL,
            pairingCode: pairingCode,
            expiresAt: expiresNumber.int64Value
        )
        try invitation.requireActive(now: now)
        try GatewayURLPolicy.requireSecureRemote(invitation.gatewayURL)
        return invitation
    }

    public static func encode(_ invitation: GatewayInvitation) throws -> URL {
        let data = try JSONEncoder.gateway.encode(invitation)
        guard let payload = String(data: data, encoding: .utf8),
              let encoded = payload.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed),
              let url = URL(string: "qwaudio://connect#\(encoded)") else {
            throw GatewayMobileError.invalidInvitation
        }
        return url
    }
}

extension JSONEncoder {
    static var gateway: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
