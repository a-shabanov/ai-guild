import AuthenticationServices
import UIKit

struct Passkey: Codable, Identifiable {
    let id: Int
    let name: String
    let backedUp: Bool
    let createdAt: Date
    let lastUsedAt: Date?
}

private struct PasskeyChallenge: Codable {
    struct Options: Codable {
        struct User: Codable {
            let id: String
            let name: String
        }

        let challenge: String
        let user: User?
    }

    let challengeId: String
    let options: Options
}

private extension Data {
    init?(base64url: String) {
        var s = base64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s.append("=") }
        self.init(base64Encoded: s)
    }

    var base64url: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// Passkeys shared with the web app. iOS only allows them for the domain this build is
/// associated with (Config.xcconfig), so they are off until that is configured.
@MainActor
final class Passkeys: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding
{
    static let shared = Passkeys()

    static var domain: String? {
        let value = Bundle.main.object(forInfoDictionaryKey: "TrackerDomain") as? String
        return value.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Passkeys work only against the associated domain, over HTTPS.
    static func isAvailable(for server: String) -> Bool {
        guard let domain, let url = URL(string: server.trimmingCharacters(in: .whitespaces)) else {
            return false
        }
        return url.scheme == "https" && url.host() == domain
    }

    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        do {
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                controller.performRequests()
            }
        } catch let error as ASAuthorizationError where error.code == .canceled {
            throw APIError.server("Проверка отменена")
        }
    }

    /// - Returns: a session token for the account the passkey belongs to.
    func signIn(server: URL) async throws -> SessionResponse {
        guard let domain = Self.domain else { throw APIError.server("Passkeys не настроены") }
        let client = APIClient(baseURL: server, key: "")
        let start: PasskeyChallenge = try await client.send("POST", "/api/passkeys/login/options")
        guard let challenge = Data(base64url: start.options.challenge) else { throw APIError.badURL }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: domain)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .required
        guard let credential = try await perform(request).credential
            as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw APIError.server("Не удалось получить passkey")
        }

        let id = credential.credentialID.base64url
        let session: SessionResponse = try await client.send("POST", "/api/passkeys/login/verify", body: [
            "challenge_id": .string(start.challengeId),
            "response": .object([
                "id": .string(id),
                "rawId": .string(id),
                "type": .string("public-key"),
                "clientExtensionResults": .object([:]),
                "response": .object([
                    "clientDataJSON": .string(credential.rawClientDataJSON.base64url),
                    "authenticatorData": .string(credential.rawAuthenticatorData.base64url),
                    "signature": .string(credential.signature.base64url),
                    "userHandle": .string(credential.userID.base64url),
                ]),
            ]),
        ])
        return session
    }

    func register(with client: APIClient, name: String) async throws {
        guard let domain = Self.domain else { throw APIError.server("Passkeys не настроены") }
        let start: PasskeyChallenge = try await client.send("POST", "/api/passkeys/register/options")
        guard let challenge = Data(base64url: start.options.challenge),
              let user = start.options.user, let userId = Data(base64url: user.id) else {
            throw APIError.badURL
        }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: domain)
        let request = provider.createCredentialRegistrationRequest(
            challenge: challenge, name: user.name, userID: userId)
        request.userVerificationPreference = .required
        guard let credential = try await perform(request).credential
            as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
            let attestation = credential.rawAttestationObject else {
            throw APIError.server("Не удалось создать passkey")
        }

        let id = credential.credentialID.base64url
        let _: Passkey = try await client.send("POST", "/api/passkeys/register/verify", body: [
            "challenge_id": .string(start.challengeId),
            "name": .string(name),
            "response": .object([
                "id": .string(id),
                "rawId": .string(id),
                "type": .string("public-key"),
                "clientExtensionResults": .object([:]),
                "response": .object([
                    "clientDataJSON": .string(credential.rawClientDataJSON.base64url),
                    "attestationObject": .string(attestation.base64url),
                    "transports": .array([.string("internal"), .string("hybrid")]),
                ]),
            ]),
        ])
    }

    // MARK: ASAuthorizationController

    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        Task { @MainActor in
            continuation?.resume(returning: authorization)
            continuation = nil
        }
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController, didCompleteWithError error: Error
    ) {
        Task { @MainActor in
            continuation?.resume(throwing: error)
            continuation = nil
        }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first { $0.isKeyWindow } ?? ASPresentationAnchor()
        }
    }
}
