import Foundation
import LocalAuthentication
import Security

/// Holds the session token. With the biometric lock on, the item is bound to the enrolled
/// Face ID / Touch ID: iOS itself refuses to release it without a successful check.
enum Keychain {
    private static let service = "dev.aitracker.app"
    private static let account = "credential"

    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// - Parameter context: an already authenticated context, so a protected item is read
    ///   without a second prompt. Without one, protected items are not read at all.
    static func load(context: LAContext? = nil) -> String? {
        var q = query
        q[kSecReturnData as String] = true
        if let context {
            q[kSecUseAuthenticationContext as String] = context
        } else {
            let silent = LAContext()
            silent.interactionNotAllowed = true
            q[kSecUseAuthenticationContext as String] = silent
        }
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Never falls back to an unprotected copy if biometric binding fails.
    static func save(_ credential: String, biometric: Bool) throws {
        if biometric {
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .biometryCurrentSet, nil) else {
                throw APIError.server("Не удалось включить \(Biometrics.name)")
            }
            try writeData(Data(credential.utf8), account: account, access: access)
        } else {
            try writeData(Data(credential.utf8), account: account)
        }
    }

    static func readData(account: String) -> Data? {
        var q = query; q[kSecAttrAccount as String] = account; q[kSecReturnData as String] = true
        let silent = LAContext(); silent.interactionNotAllowed = true
        q[kSecUseAuthenticationContext as String] = silent
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func writeData(_ data: Data, account: String, access: SecAccessControl? = nil) throws {
        var q = query; q[kSecAttrAccount as String] = account
        // Replace atomically where possible, preserving an existing record on failure.
        let update: [String: Any] = [kSecValueData as String: data]
        if access == nil && SecItemUpdate(q as CFDictionary, update as CFDictionary) == errSecSuccess { return }
        var item = q; item[kSecValueData as String] = data
        if let access { item[kSecAttrAccessControl as String] = access }
        else { item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly }
        let added = SecItemAdd(item as CFDictionary, nil)
        if added == errSecDuplicateItem {
            // The credential copy changes its access policy only after authentication.
            SecItemDelete(q as CFDictionary)
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw APIError.server("Не удалось сохранить защищённый вход") }
        } else if added != errSecSuccess {
            #if DEBUG
            print("Keychain write failed with OSStatus \(added)")
            #endif
            throw APIError.server("Не удалось сохранить защищённый вход")
        }
    }
    static func deleteData(account: String) {
        var q = query; q[kSecAttrAccount as String] = account
        SecItemDelete(q as CFDictionary)
    }

    static func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

enum Biometrics {
    // The sensor type never changes while the app runs; views ask for it on every render.
    static let kind: LABiometryType = {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        return context.biometryType
    }()

    static var isAvailable: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    }

    static var name: String {
        switch kind {
        case .touchID: "Touch ID"
        case .opticID: "Optic ID"
        default: "Face ID"
        }
    }

    static var icon: String {
        switch kind {
        case .touchID: "touchid"
        case .opticID: "opticid"
        default: "faceid"
        }
    }

    /// Asks for the face or finger and returns the context that proves it.
    static func authenticate(reason: String) async throws -> LAContext {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        do {
            try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        } catch let error as LAError {
            throw BiometricError(error)
        }
        return context
    }
}

struct BiometricError: LocalizedError {
    let cancelled: Bool
    let errorDescription: String?

    init(_ error: LAError) {
        switch error.code {
        case .userCancel, .appCancel, .systemCancel:
            cancelled = true
            errorDescription = "Проверка отменена"
        case .biometryNotEnrolled:
            cancelled = false
            errorDescription = "\(Biometrics.name) не настроен на этом устройстве"
        case .biometryLockout:
            cancelled = false
            errorDescription = "\(Biometrics.name) заблокирован после неудачных попыток. Разблокируйте устройство кодом-паролем."
        case .biometryNotAvailable:
            cancelled = false
            errorDescription = "\(Biometrics.name) недоступен. Проверьте разрешение в Настройках."
        default:
            cancelled = false
            errorDescription = "Не удалось проверить \(Biometrics.name)"
        }
    }
}
