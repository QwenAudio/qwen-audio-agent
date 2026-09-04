import Foundation
import Testing
@testable import QwenAudioAgentMobile

@Suite("Gateway invitation codec")
struct GatewayInvitationCodecTests {
    private let future = Date(timeIntervalSince1970: 1_799_999_000)

    @Test("round trips the canonical deep link")
    func roundTrip() throws {
        let invitation = try GatewayInvitation(
            gatewayURL: #require(URL(string: "https://phone.example.ts.net")),
            pairingCode: "one-time-code",
            expiresAt: 1_800_000_000_000
        )
        let encoded = try GatewayInvitationCodec.encode(invitation)
        #expect(try GatewayInvitationCodec.decode(encoded, now: future) == invitation)
        #expect(encoded.absoluteString.hasPrefix("qwaudio://connect#"))
    }

    @Test("rejects expired invitations")
    func rejectsExpired() throws {
        let invitation = try GatewayInvitation(
            gatewayURL: #require(URL(string: "https://phone.example.ts.net")),
            pairingCode: "expired-code",
            expiresAt: 1_700_000_000_000
        )
        let encoded = try GatewayInvitationCodec.encode(invitation)
        #expect(throws: GatewayMobileError.invitationExpired) {
            try GatewayInvitationCodec.decode(encoded, now: future)
        }
    }

    @Test("rejects public plaintext and contaminated origins")
    func rejectsUnsafeOrigins() throws {
        let plaintext = try GatewayInvitation(
            gatewayURL: #require(URL(string: "http://gateway.example.test")),
            pairingCode: "temporary",
            expiresAt: 1_800_000_000_000
        )
        #expect(throws: GatewayMobileError.insecureRemoteGateway) {
            try GatewayURLPolicy.requireSecureRemote(plaintext.gatewayURL)
        }
        for value in [
            "https://user:secret@gateway.example.test",
            "https://gateway.example.test/path",
            "https://gateway.example.test?token=secret",
        ] {
            #expect(throws: GatewayMobileError.invalidGatewayURL) {
                _ = try GatewayInvitation(
                    gatewayURL: #require(URL(string: value)),
                    pairingCode: "temporary",
                    expiresAt: 1_800_000_000_000
                )
            }
        }
    }

    @Test("rejects unknown invitation fields")
    func rejectsUnknownFields() throws {
        let payload = """
        {"version":1,"gateway_url":"https://gateway.example.test","pairing_code":"temporary","expires_at":1800000000000,"access_token":"must-not-enter-a-qr-code"}
        """
        let encoded = try #require(
            payload.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed)
        )
        let url = try #require(URL(string: "qwaudio://connect#\(encoded)"))
        #expect(throws: GatewayMobileError.invalidInvitation) {
            try GatewayInvitationCodec.decode(url, now: future)
        }
    }
}
