import Foundation
import Testing
@testable import QwenAudioAgentMobile

@Suite("Gateway session models")
struct GatewaySessionModelsTests {
    @Test("encodes a mobile GCP 6.0 hello")
    func encodesHello() throws {
        let configuration = GatewaySessionConfiguration(
            clientVersion: "0.1.0",
            clientInstanceID: "mobile_phone",
            clientLabel: "My iPhone",
            capabilities: [GatewayMobileCapabilities.inputAudio],
            takeover: true
        )
        let hello = GatewaySessionHello(configuration: configuration, eventID: "evt_mobile")
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder.gateway.encode(hello)) as? [String: Any]
        )
        #expect(object["type"] as? String == "session.hello")
        #expect(object["event_id"] as? String == "evt_mobile")
        let client = try #require(object["client"] as? [String: Any])
        #expect(client["type"] as? String == "mobile")
        let capabilities = try #require(object["capabilities"] as? [String])
        #expect(capabilities.contains(GatewayMobileCapabilities.takeover))
    }

    @Test("decodes the GCP 6.0 ready envelope")
    func decodesReady() throws {
        let data = Data(#"{"type":"session.ready","event_id":"evt_server","request_event_id":"evt_mobile","protocol_version":"6.0.0","session_id":"main","capabilities":["input.audio","session.replay"]}"#.utf8)
        let ready = try JSONDecoder().decode(GatewaySessionReady.self, from: data)
        #expect(ready.type == "session.ready")
        #expect(ready.protocolVersion == gatewayClientProtocolVersion)
        #expect(ready.capabilities == ["input.audio", "session.replay"])
    }

    @Test("connection profiles never serialize credentials")
    func profileContainsOnlyReference() throws {
        let profile = try GatewayConnectionProfile(
            id: "phone",
            gatewayURL: #require(URL(string: "https://gateway.example.test")),
            deviceID: "device_phone",
            credentialReference: "keychain/device_phone",
            clientInstanceID: "mobile_phone",
            label: "My iPhone"
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder.gateway.encode(profile)) as? [String: Any]
        )
        #expect(object["credential_ref"] as? String == "keychain/device_phone")
        #expect(object["access_token"] == nil)
    }

    @Test("rejects invalid persisted connection profiles")
    func rejectsInvalidPersistedProfile() {
        let data = Data(#"{"version":2,"id":"phone","gateway_url":"https://gateway.example.test","device_id":"device_phone","credential_ref":"keychain/device_phone","client_instance_id":"mobile_phone"}"#.utf8)
        #expect(throws: (any Error).self) {
            _ = try JSONDecoder().decode(GatewayConnectionProfile.self, from: data)
        }
    }
}
