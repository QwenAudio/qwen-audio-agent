import Foundation

public struct GatewayPairingOutcome: Equatable, Sendable {
    public let profile: GatewayConnectionProfile
    public let ownerID: String

    public init(profile: GatewayConnectionProfile, ownerID: String) {
        self.profile = profile
        self.ownerID = ownerID
    }
}

public struct GatewayPairingClient: Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func pair(
        invitation: GatewayInvitation,
        device: GatewayDevice,
        clientInstanceID: String,
        profileID: String? = nil,
        credentialStore: any GatewayCredentialStoring,
        profileStore: any GatewayProfileStoring,
        now: Date = Date()
    ) async throws -> GatewayPairingOutcome {
        try invitation.requireActive(now: now)
        try GatewayURLPolicy.requireSecureRemote(invitation.gatewayURL)

        let endpoint = invitation.gatewayURL.appending(path: "api/access/pair")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder.gateway.encode(PairingRequest(
            code: invitation.pairingCode,
            device: device
        ))

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayMobileError.invalidPairingResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let failure = try? JSONDecoder().decode(GatewayFailure.self, from: data)
            throw GatewayMobileError.pairingFailed(
                status: http.statusCode,
                code: failure?.code,
                message: failure?.error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            )
        }
        guard let paired = try? JSONDecoder().decode(PairingResponse.self, from: data),
              !paired.accessToken.isEmpty,
              !paired.ownerID.isEmpty,
              !paired.device.id.isEmpty else {
            throw GatewayMobileError.invalidPairingResponse
        }

        let credentialReference = "gateway/\(paired.device.id)"
        let profile = try GatewayConnectionProfile(
            id: profileID ?? device.id,
            gatewayURL: invitation.gatewayURL,
            deviceID: paired.device.id,
            credentialReference: credentialReference,
            clientInstanceID: clientInstanceID,
            label: device.label
        )

        try await credentialStore.setCredential(paired.accessToken, for: credentialReference)
        do {
            try await profileStore.saveProfile(profile)
        } catch {
            try? await credentialStore.removeCredential(for: credentialReference)
            throw error
        }
        return GatewayPairingOutcome(profile: profile, ownerID: paired.ownerID)
    }
}

private struct PairingRequest: Encodable {
    let code: String
    let device: GatewayDevice
}

private struct PairingResponse: Decodable {
    let accessToken: String
    let ownerID: String
    let device: GatewayDevice

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case ownerID = "owner_id"
        case device
    }
}

private struct GatewayFailure: Decodable {
    let error: String?
    let code: String?
}
