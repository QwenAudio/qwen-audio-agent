import Foundation
import Testing
@testable import QwenAudioAgentMobile

@Suite("Gateway pairing client", .serialized)
struct GatewayPairingClientTests {
    @Test("redeems once and separates the token from the profile")
    func pairsAndPersistsSecurely() async throws {
        let credentials = MemoryCredentialStore()
        let profiles = MemoryProfileStore()
        let session = URLSession(configuration: MockURLProtocol.configuration { request in
            #expect(request.url?.absoluteString == "https://gateway.example.test/api/access/pair")
            #expect(request.httpMethod == "POST")
            let requestBody = try request.bodyData()
            let object = try #require(
                JSONSerialization.jsonObject(with: requestBody) as? [String: Any]
            )
            #expect(object["code"] as? String == "one-time-code")
            let device = try #require(object["device"] as? [String: Any])
            #expect(device["type"] as? String == "mobile")
            let body = Data(#"{"access_token":"qwa_device_secret","owner_id":"user_personal","device":{"id":"device_phone","type":"mobile","label":"My iPhone"}}"#.utf8)
            return (
                HTTPURLResponse(
                    url: try #require(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["content-type": "application/json"]
                )!,
                body
            )
        })
        let invitation = try GatewayInvitation(
            gatewayURL: #require(URL(string: "https://gateway.example.test")),
            pairingCode: "one-time-code",
            expiresAt: 1_800_000_000_000
        )

        let outcome = try await GatewayPairingClient(session: session).pair(
            invitation: invitation,
            device: GatewayDevice(id: "phone", label: "My iPhone"),
            clientInstanceID: "mobile-instance",
            credentialStore: credentials,
            profileStore: profiles,
            now: Date(timeIntervalSince1970: 1_700_000_000)
        )

        #expect(outcome.ownerID == "user_personal")
        #expect(outcome.profile.deviceID == "device_phone")
        #expect(outcome.profile.credentialReference == "gateway/device_phone")
        #expect(await credentials.credential(for: "gateway/device_phone") == "qwa_device_secret")
        #expect(await profiles.profile(id: "phone") == outcome.profile)
        let serialized = String(data: try JSONEncoder.gateway.encode(outcome.profile), encoding: .utf8)
        #expect(serialized?.contains("qwa_device_secret") == false)
    }

    @Test("rolls back the credential when profile persistence fails")
    func rollsBackCredential() async throws {
        let credentials = MemoryCredentialStore()
        let profiles = MemoryProfileStore(shouldFail: true)
        let session = URLSession(configuration: MockURLProtocol.configuration { request in
            let body = Data(#"{"access_token":"qwa_device_secret","owner_id":"user_personal","device":{"id":"device_phone","type":"mobile"}}"#.utf8)
            return (
                HTTPURLResponse(
                    url: try #require(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: nil
                )!,
                body
            )
        })
        let invitation = try GatewayInvitation(
            gatewayURL: #require(URL(string: "https://gateway.example.test")),
            pairingCode: "one-time-code",
            expiresAt: 1_800_000_000_000
        )

        await #expect(throws: TestFailure.self) {
            _ = try await GatewayPairingClient(session: session).pair(
                invitation: invitation,
                device: GatewayDevice(id: "phone"),
                clientInstanceID: "mobile-instance",
                credentialStore: credentials,
                profileStore: profiles,
                now: Date(timeIntervalSince1970: 1_700_000_000)
            )
        }
        #expect(await credentials.credential(for: "gateway/device_phone") == nil)
    }
}

private actor MemoryCredentialStore: GatewayCredentialStoring {
    private var values: [String: String] = [:]

    func credential(for reference: String) -> String? { values[reference] }
    func setCredential(_ credential: String, for reference: String) { values[reference] = credential }
    func removeCredential(for reference: String) { values.removeValue(forKey: reference) }
}

private actor MemoryProfileStore: GatewayProfileStoring {
    private var values: [String: GatewayConnectionProfile] = [:]
    private let shouldFail: Bool

    init(shouldFail: Bool = false) { self.shouldFail = shouldFail }

    func profile(id: String) -> GatewayConnectionProfile? { values[id] }
    func saveProfile(_ profile: GatewayConnectionProfile) throws {
        if shouldFail { throw TestFailure() }
        values[profile.id] = profile
    }
    func removeProfile(id: String) { values.removeValue(forKey: id) }
}

private struct TestFailure: Error {}

private extension URLRequest {
    func bodyData() throws -> Data {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { throw TestFailure() }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? TestFailure() }
            if count == 0 { break }
            result.append(buffer, count: count)
        }
        return result
    }
}

private final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    private nonisolated(unsafe) static var handler: Handler?

    static func configuration(handler: @escaping Handler) -> URLSessionConfiguration {
        self.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return configuration
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw TestFailure() }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
