import Foundation
import Security

public protocol GatewayCredentialStoring: Sendable {
    func credential(for reference: String) async throws -> String?
    func setCredential(_ credential: String, for reference: String) async throws
    func removeCredential(for reference: String) async throws
}

public protocol GatewayProfileStoring: Sendable {
    func profile(id: String) async throws -> GatewayConnectionProfile?
    func saveProfile(_ profile: GatewayConnectionProfile) async throws
    func removeProfile(id: String) async throws
}

public actor KeychainGatewayCredentialStore: GatewayCredentialStoring {
    private let service: String

    public init(service: String = "org.qwen.audio-agent.gateway") {
        self.service = service
    }

    public func credential(for reference: String) throws -> String? {
        var query = baseQuery(reference: reference)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw KeychainError(status: status)
        }
        return value
    }

    public func setCredential(_ credential: String, for reference: String) throws {
        guard !credential.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let data = credential.data(using: .utf8) else {
            throw GatewayMobileError.missingCredential
        }
        let query = baseQuery(reference: reference)
        let updates: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainError(status: updateStatus)
        }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError(status: addStatus)
        }
    }

    public func removeCredential(for reference: String) throws {
        let status = SecItemDelete(baseQuery(reference: reference) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }

    private func baseQuery(reference: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: reference,
        ]
    }
}

public struct KeychainError: Error, LocalizedError, Sendable {
    public let status: OSStatus

    public var errorDescription: String? {
        SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"
    }
}

public actor UserDefaultsGatewayProfileStore: GatewayProfileStoring {
    private let defaults: UserDefaults
    private let key: String

    public init(
        defaults: UserDefaults = .standard,
        key: String = "qwenAudioAgent.gatewayConnectionProfiles"
    ) {
        self.defaults = defaults
        self.key = key
    }

    public func profile(id: String) throws -> GatewayConnectionProfile? {
        try profiles().first(where: { $0.id == id })
    }

    public func saveProfile(_ profile: GatewayConnectionProfile) throws {
        var values = try profiles()
        if let index = values.firstIndex(where: { $0.id == profile.id }) {
            values[index] = profile
        } else {
            values.append(profile)
        }
        defaults.set(try JSONEncoder.gateway.encode(values), forKey: key)
    }

    public func removeProfile(id: String) throws {
        let values = try profiles().filter { $0.id != id }
        defaults.set(try JSONEncoder.gateway.encode(values), forKey: key)
    }

    private func profiles() throws -> [GatewayConnectionProfile] {
        guard let data = defaults.data(forKey: key) else { return [] }
        return try JSONDecoder().decode([GatewayConnectionProfile].self, from: data)
    }
}
