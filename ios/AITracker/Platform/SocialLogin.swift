import AuthenticationServices
import CryptoKit
import Security
import UIKit

struct SocialIdentity: Codable, Identifiable {
    var id: String { provider }
    let provider: String
    let label: String
}

struct SignInProviders: Codable {
    let google: Bool
    let telegram: Bool
    func enabled(_ provider: String) -> Bool { provider == "google" ? google : telegram }
}

private struct SocialStart: Codable { let authorizationUrl: String }
private struct SocialExchange: Codable { let sessionToken: String?; let ok: Bool? }

/// ASWebAuthenticationSession opens the provider in a system browser. A one-use code,
/// bound to a verifier held by this app, returns instead of a session token in a URL.
@MainActor
final class SocialLogin: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = SocialLogin()
    private var session: ASWebAuthenticationSession?

    func authorize(provider: String, client: APIClient, linking: Bool = false) async throws -> String? {
        guard session == nil else { throw APIError.server("Вход уже выполняется") }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw APIError.server("Не удалось начать вход")
        }
        let verifier = Self.base64url(Data(bytes))
        let challenge = Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        let start: SocialStart = try await client.send("POST", "/api/auth/\(provider)/start", body: [
            "intent": .string(linking ? "link" : "login"), "code_challenge": .string(challenge),
        ])
        guard let url = URL(string: start.authorizationUrl), ["https", "http"].contains(url.scheme ?? "") else {
            throw APIError.badURL
        }
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let authentication = ASWebAuthenticationSession(url: url, callbackURLScheme: "aitracker") { url, error in
                Task { @MainActor in
                    self.session = nil
                    if let url { continuation.resume(returning: url) }
                    else { continuation.resume(throwing: APIError.server(
                        (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin ? "Вход отменён" : "Не удалось завершить вход")) }
                }
            }
            session = authentication
            authentication.presentationContextProvider = self
            authentication.prefersEphemeralWebBrowserSession = true
            if !authentication.start() {
                session = nil
                continuation.resume(throwing: APIError.server("Не удалось открыть окно входа"))
            }
        }
        guard callback.scheme == "aitracker", callback.host == "auth",
              let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false) else { throw APIError.badURL }
        if let error = parts.queryItems?.first(where: { $0.name == "error" })?.value { throw APIError.server(error) }
        guard let code = parts.queryItems?.first(where: { $0.name == "code" })?.value else { throw APIError.badURL }
        let result: SocialExchange = try await client.send("POST", "/api/auth/exchange", body: [
            "code": .string(code), "code_verifier": .string(verifier),
        ])
        if linking {
            guard result.ok == true else { throw APIError.server("Не удалось привязать аккаунт") }
        } else if result.sessionToken == nil { throw APIError.server("Не удалось получить сессию") }
        return result.sessionToken
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
