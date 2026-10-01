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

    /// - Returns: false when the device could not bind the item to biometrics and it was
    ///   stored as an ordinary device-only item instead.
    @discardableResult
    static func save(_ credential: String, biometric: Bool) -> Bool {
        delete()
        var q = query
        q[kSecValueData as String] = Data(credential.utf8)
        if biometric,
           let access = SecAccessControlCreateWithFlags(
               nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .biometryCurrentSet, nil)
        {
            var bound = q
            bound[kSecAttrAccessControl as String] = access
            if SecItemAdd(bound as CFDictionary, nil) == errSecSuccess { return true }
        }
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
        return !biometric
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
