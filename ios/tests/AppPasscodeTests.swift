import Foundation

// Compile this file as main.swift together with Platform/AppPasscode.swift.
// No device Keychain or live session is touched by these crypto/lockout tests.
enum Keychain {
    static var storage: [String: Data] = [:]
    static func readData(account: String) -> Data? { storage[account] }
    static func writeData(_ data: Data, account: String) throws { storage[account] = data }
    static func deleteData(account: String) { storage.removeValue(forKey: account) }
}
enum APIError: Error { case server(String) }
func expectFailure(_ action: () throws -> Void) {
    do { try action(); fatalError("Expected rejection") } catch {}
}
let secret = "ats_disposable_test_credential"
func checkSecret(_ code: String) throws { let recovered = try AppPasscode.unlock(code: code); assert(recovered == secret) }
assert(!AppPasscode.isConfigured)
expectFailure { try AppPasscode.save(credential: secret, code: "123") }
expectFailure { try AppPasscode.save(credential: secret, code: "１２３４５６") }
try AppPasscode.save(credential: secret, code: "123456")
assert(AppPasscode.isConfigured)
let first = Keychain.storage["app-passcode"]!
assert(!String(data: first, encoding: .utf8)!.contains(secret))
assert(!String(data: first, encoding: .utf8)!.contains("123456"))
try checkSecret("123456")
try AppPasscode.save(credential: secret, code: "123456")
assert(first != Keychain.storage["app-passcode"]!) // fresh salt and nonce
for _ in 0..<5 { expectFailure { _ = try AppPasscode.unlock(code: "000000") } }
assert(AppPasscode.retryAt! > .now)
expectFailure { _ = try AppPasscode.unlock(code: "123456") }
// Simulate time passing while preserving the persisted attempt count.
var record = try JSONSerialization.jsonObject(with: Keychain.storage["app-passcode"]!) as! [String: Any]
record["retryAt"] = Date.now.addingTimeInterval(-1).timeIntervalSinceReferenceDate
Keychain.storage["app-passcode"] = try JSONSerialization.data(withJSONObject: record)
try checkSecret("123456")
assert(AppPasscode.retryAt == nil)
try AppPasscode.save(credential: secret, code: "654321")
expectFailure { _ = try AppPasscode.unlock(code: "123456") }
try checkSecret("654321")
// Corruption fails closed and does not silently erase the code protection.
Keychain.storage["app-passcode"] = Data("broken".utf8)
expectFailure { _ = try AppPasscode.unlock(code: "654321") }
assert(AppPasscode.isConfigured)
AppPasscode.delete()
assert(!AppPasscode.isConfigured)
print("AppPasscode: encryption, salt uniqueness, PIN validation, cooldown persistence, code change and corruption checks passed")
