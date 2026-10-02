import Foundation
import CryptoKit
import CommonCrypto
import Security

/// The session is encrypted with the app code. A separate biometric copy is optional.
/// Failed attempts and cooldown live in the device-only Keychain, so relaunching cannot reset them.
enum AppPasscode {
    private struct Record: Codable {
        var salt: Data
        var sealed: Data
        var attempts = 0
        var retryAt: Date?
    }
    private static let account = "app-passcode"
    static var isConfigured: Bool { Keychain.readData(account: account) != nil }
    static var retryAt: Date? { try? record().retryAt }

    private static func record() throws -> Record {
        guard let data = Keychain.readData(account: account) else {
            throw APIError.server("Создайте код-пароль приложения")
        }
        return try JSONDecoder().decode(Record.self, from: data)
    }
    private static func write(_ record: Record) throws {
        try Keychain.writeData(JSONEncoder().encode(record), account: account)
    }
    private static func derive(_ code: String, salt: Data) throws -> SymmetricKey {
        var bytes = [UInt8](repeating: 0, count: 32)
        let password = Array(code.utf8)
        let result = password.withUnsafeBytes { pass in
            salt.withUnsafeBytes { saltBytes in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pass.baseAddress?.assumingMemoryBound(to: Int8.self),
                    password.count, saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 310_000, &bytes, bytes.count)
            }
        }
        guard result == kCCSuccess else { throw APIError.server("Не удалось защитить код-пароль") }
        return SymmetricKey(data: bytes)
    }
    static func save(credential: String, code: String) throws {
        guard code.count == 6, code.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            throw APIError.server("Введите шесть цифр")
        }
        var salt = Data(count: 16)
        let result = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        guard result == errSecSuccess else { throw APIError.server("Не удалось создать код-пароль") }
        let box = try AES.GCM.seal(Data(credential.utf8), using: derive(code, salt: salt))
        guard let combined = box.combined else { throw APIError.server("Не удалось сохранить код-пароль") }
        try write(Record(salt: salt, sealed: combined))
    }
    static func unlock(code: String) throws -> String {
        var saved = try record()
        if let retryAt = saved.retryAt, retryAt > .now {
            throw APIError.server("Слишком много попыток. Подождите \(Int(retryAt.timeIntervalSinceNow.rounded(.up))) с")
        }
        let data: Data
        do { data = try AES.GCM.open(AES.GCM.SealedBox(combined: saved.sealed), using: derive(code, salt: saved.salt)) }
        catch {
            saved.attempts += 1
            if saved.attempts >= 5 { saved.retryAt = .now.addingTimeInterval(min(300, 30 * pow(2, Double(min(saved.attempts - 5, 4))))) }
            try write(saved)
            throw APIError.server(saved.retryAt.map { "Слишком много попыток. Подождите \(Int($0.timeIntervalSinceNow.rounded(.up))) с" } ?? "Неверный код-пароль")
        }
        guard let credential = String(data: data, encoding: .utf8) else { throw APIError.server("Войдите в аккаунт снова") }
        saved.attempts = 0; saved.retryAt = nil
        try write(saved)
        return credential
    }
    static func resetAttempts() throws {
        var saved = try record(); saved.attempts = 0; saved.retryAt = nil; try write(saved)
    }
    static func delete() { Keychain.deleteData(account: account) }
}
