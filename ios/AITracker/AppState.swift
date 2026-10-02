import Foundation
import Observation

enum AppTab: Hashable {
    case projects, tasks, inbox, analytics, settings
}

/// Somewhere to go, asked for from outside the UI: a notification, a home-screen shortcut.
enum Destination: Equatable {
    case tab(AppTab)
    case task(Int)
    case newTask
    case board
    case project(ProjectScreen)
}

@MainActor
@Observable
final class AppState {
    static let shared = AppState()

    enum Phase {
        case restoring, signedOut, settingPasscode, locked, ready
    }

    private(set) var phase = Phase.restoring
    private(set) var client: APIClient?
    private(set) var me: Account?
    private(set) var accounts: [Account] = []
    private(set) var secondFactor: SessionResponse?
    private var secondFactorServer: URL?
    var inboxCount = 0 {
        didSet { Notifier.setBadge(inboxCount) }
    }

    var securityNotice: String?
    var tab = AppTab.projects
    /// Consumed by the tasks screen once it is on screen.
    var pending: Destination?

    private(set) var biometricLock = UserDefaults.standard.bool(forKey: "biometricLock")
    private var pendingCredential: String?
    private var sessionGeneration = 0
    private var backgroundedAt: Date?
    private static let lockAfter: TimeInterval = 60

    private(set) var serverConfig: ServerConfig?
    private(set) var availableUpdate: String?
    private(set) var updateCheckError: String?
    private(set) var updateChecked = false
    private var checkingUpdate = false

    func checkForUpdates() async {
        guard let client, !checkingUpdate else { return }
        let generation = sessionGeneration
        checkingUpdate = true
        defer { checkingUpdate = false }
        do {
            let config: ServerConfig = try await client.get("/api/config")
            guard let version = config.version, let build = config.build,
                  let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
                  let currentBuild = Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "") else {
                throw APIError.server("Не удалось проверить обновления")
            }
            guard generation == sessionGeneration else { return }
            serverConfig = config
            // This repository releases the server, web and iOS with one version/build.
            let comparison = version.compare(currentVersion, options: .numeric)
            availableUpdate = comparison == .orderedDescending || (comparison == .orderedSame && build > currentBuild)
                ? "\(version) (\(build))" : nil
            updateChecked = true; updateCheckError = nil
        } catch { if generation == sessionGeneration { updateCheckError = error.localizedDescription } }
    }

    func beginPasscodeSetup() {
        guard phase == .ready, !AppPasscode.isConfigured, let client else { return }
        pendingCredential = client.key
        phase = .settingPasscode
    }

    var serverURL: String {
        if let saved = UserDefaults.standard.string(forKey: "serverURL") { return saved }
        let built = Bundle.main.object(forInfoDictionaryKey: "TrackerServer") as? String ?? ""
        return built.isEmpty ? "http://localhost:4600" : "http://\(built)"
    }

    // MARK: Session

    func restore() async {
        #if DEBUG
        // Lets UI checks sign in without typing:
        // SIMCTL_CHILD_AITRACKER_KEY=... SIMCTL_CHILD_AITRACKER_SERVER=... xcrun simctl launch ...
        let env = ProcessInfo.processInfo.environment
        // Deterministic, disconnected UI/crypto checks. Never compiled into release builds.
        if let screen = env["AITRACKER_PASSCODE_PREVIEW"] {
            signOut()
            if let server = env["AITRACKER_PREVIEW_SERVER"] { UserDefaults.standard.set(server, forKey: "serverURL") }
            pendingCredential = env["AITRACKER_PREVIEW_TOKEN"] ?? "ats_disposable-preview-session"
            if screen == "setup" { phase = .settingPasscode }
            else {
                do {
                    try AppPasscode.save(credential: pendingCredential!, code: "123456")
                    if screen == "biometric" {
                        try Keychain.save(pendingCredential!, biometric: true)
                        setBiometricFlag(true)
                    }
                    pendingCredential = nil; phase = .locked
                    if screen == "settings" { try await unlock(code: "123456"); tab = .settings }
                    if env["AITRACKER_PREVIEW_CHECK"] == "1" {
                        do { try await unlock(code: "000000"); print("AppState test: wrong code unexpectedly accepted") }
                        catch { print("AppState test: wrong code rejected, locked=\(phase == .locked)") }
                        try await unlock(code: "123456")
                        print("AppState test: correct code ready=\(phase == .ready)")
                    }
                } catch { phase = .signedOut }
            }
            return
        }
        if let key = env["AITRACKER_KEY"] {
            try? await signIn(server: env["AITRACKER_SERVER"] ?? serverURL, key: key)
            if phase == .restoring { phase = .signedOut }
            // AITRACKER_OPEN_TASK=12 opens that task, like tapping its notification.
            if let id = env["AITRACKER_OPEN_TASK"].flatMap(Int.init) { open(.task(id)) }
            // AITRACKER_OPEN=board | board:StillHere | timeline:StillHere
            if let screen = env["AITRACKER_OPEN"] {
                let parts = screen.split(separator: ":", maxSplits: 1).map(String.init)
                switch (parts[0], parts.count > 1 ? parts[1] : nil) {
                case ("board", nil): open(.board)
                case ("board", let name?): open(.project(.board(name)))
                case ("timeline", let name?): open(.project(.timeline(name)))
                default: break
                }
            }
            return
        }
        #endif
        if AppPasscode.isConfigured || biometricLock {
            phase = .locked
            return
        }
        guard let credential = Keychain.load() else {
            phase = .signedOut
            return
        }
        try? await connect(credential: credential)
    }

    func unlock() async throws {
        guard phase == .locked, biometricLock else { return }
        let generation = sessionGeneration
        let context = try await Biometrics.authenticate(reason: "Разблокировать AI Guild")
        guard generation == sessionGeneration, phase == .locked else { return }
        guard let credential = Keychain.load(context: context) else {
            if AppPasscode.isConfigured {
                setBiometricFlag(false)
                throw APIError.server("Данные \(Biometrics.name) изменились. Введите код-пароль и включите биометрию заново.")
            }
            signOut()
            throw APIError.server("Войдите в аккаунт снова")
        }
        if AppPasscode.isConfigured { try AppPasscode.resetAttempts() }
        try await connect(credential: credential)
    }

    func unlock(code: String) async throws {
        guard phase == .locked else { return }
        try await connect(credential: try AppPasscode.unlock(code: code))
    }

    func createPasscode(_ code: String, biometric: Bool) async throws {
        guard phase == .settingPasscode, let credential = pendingCredential else { return }
        let generation = sessionGeneration
        try AppPasscode.save(credential: credential, code: code)
        Keychain.delete()
        setBiometricFlag(false)
        if biometric {
            do {
                _ = try await Biometrics.authenticate(reason: "Включить разблокировку через \(Biometrics.name)")
                guard generation == sessionGeneration else { return }
                try Keychain.save(credential, biometric: true)
                setBiometricFlag(true)
            } catch {
                // The code is already safely stored and remains the fallback.
                guard generation == sessionGeneration else { return }
                pendingCredential = nil
                securityNotice = "Код-пароль сохранён, но \(Biometrics.name) не включён. \(error.localizedDescription). Его можно включить в настройках защиты приложения."
                phase = .ready; Notifier.resume(); await refreshShared()
                return
            }
        }
        guard generation == sessionGeneration else { return }
        pendingCredential = nil
        phase = .ready
        Notifier.resume()
        await refreshShared()
    }

    func changePasscode(current: String, new: String) throws {
        let credential = try AppPasscode.unlock(code: current)
        try AppPasscode.save(credential: credential, code: new)
    }

    private func connect(credential: String) async throws {
        guard let url = URL(string: serverURL) else {
            phase = .signedOut
            return
        }
        let generation = sessionGeneration
        let candidate = APIClient(baseURL: url, key: credential)
        do {
            let account: Account = try await candidate.get("/api/me")
            guard generation == sessionGeneration else { return }
            me = account
            client = candidate
            if AppPasscode.isConfigured {
                phase = .ready; Notifier.resume(); await refreshShared()
            } else {
                pendingCredential = credential; phase = .settingPasscode
            }
        } catch APIError.unauthorized {
            guard generation == sessionGeneration else { return }
            signOut()
        } catch {
            guard generation == sessionGeneration else { return }
            // Keep the protected session and let the owner retry without signing out.
            phase = AppPasscode.isConfigured || biometricLock ? .locked : .signedOut
            throw error
        }
    }

    private func parse(server: String) throws -> URL {
        let trimmed = server.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: trimmed), url.scheme != nil, url.host() != nil else {
            throw APIError.badURL
        }
        return url
    }

    private func adopt(server: URL, token: String) async throws {
        let candidate = APIClient(baseURL: server, key: token)
        let account: Account = try await candidate.get("/api/me")
        UserDefaults.standard.set(server.absoluteString, forKey: "serverURL")
        sessionGeneration += 1
        AppPasscode.delete()
        Keychain.delete()
        pendingCredential = token
        setBiometricFlag(false)
        client = candidate
        me = account
        phase = .settingPasscode
    }

    /// Trades the API key for a revocable session, so the key itself is never stored.
    func signIn(server: String, key: String) async throws {
        let url = try parse(server: server)
        let anonymous = APIClient(baseURL: url, key: "")
        do {
            let session: SessionResponse = try await anonymous.send("POST", "/api/session", body: [
                "key": .string(key.trimmingCharacters(in: .whitespacesAndNewlines)),
            ])
            try await acceptSignIn(session, server: url)
        } catch where error.isConnectivity {
            // On the sign-in screen the address is the usual suspect: say which one was tried and why it failed.
            let reason = (error as? URLError)?.localizedDescription ?? ""
            throw APIError.server("Нет соединения с \(url.absoluteString). \(reason)")
        }
    }

    func signInWithPasskey(server: String) async throws {
        let url = try parse(server: server)
        try await acceptSignIn(try await Passkeys.shared.signIn(server: url), server: url)
    }

    func signInWithProvider(server: String, provider: String) async throws {
        let url = try parse(server: server)
        let anonymous = APIClient(baseURL: url, key: "")
        try await acceptSignIn(try await SocialLogin.shared.authorize(provider: provider, client: anonymous), server: url)
    }

    private func acceptSignIn(_ response: SessionResponse, server: URL) async throws {
        if response.twoFactorRequired == true, let token = response.challengeToken, token.count == 43 {
            secondFactor = response
            secondFactorServer = server
            phase = .signedOut
        } else if let token = response.sessionToken {
            secondFactor = nil
            secondFactorServer = nil
            try await adopt(server: server, token: token)
        } else { throw APIError.server("Не удалось получить сессию") }
    }

    func sendSecondFactor(channel: String) async throws -> TwoFactorSent {
        guard let server = secondFactorServer, let token = secondFactor?.challengeToken else { throw APIError.server("Войдите снова") }
        return try await APIClient(baseURL: server, key: "").send("POST", "/api/auth/2fa/send", body: [
            "challenge_token": .string(token), "channel": .string(channel),
        ])
    }

    func verifySecondFactor(code: String) async throws {
        guard let server = secondFactorServer, let token = secondFactor?.challengeToken else { throw APIError.server("Войдите снова") }
        let response: SessionResponse = try await APIClient(baseURL: server, key: "").send("POST", "/api/auth/2fa/verify", body: [
            "challenge_token": .string(token), "code": .string(code),
        ])
        try await acceptSignIn(response, server: server)
    }

    func cancelSecondFactor() {
        if let server = secondFactorServer, let token = secondFactor?.challengeToken {
            Task { let _: OK? = try? await APIClient(baseURL: server, key: "").send("DELETE", "/api/auth/2fa/pending", body: ["challenge_token": .string(token)]) }
        }
        secondFactor = nil
        secondFactorServer = nil
    }

    func signOut() {
        sessionGeneration += 1
        pendingCredential = nil
        securityNotice = nil
        serverConfig = nil; availableUpdate = nil; updateCheckError = nil; updateChecked = false
        cancelSecondFactor()
        if let client {
            Task {
                if let token = Notifier.deviceToken {
                    let _: OK? = try? await client.send("DELETE", "/api/push/apns", body: ["token": .string(token)])
                }
                let _: OK? = try? await client.send("DELETE", "/api/session")
            }
        }
        Keychain.delete()
        AppPasscode.delete()
        setBiometricFlag(false)
        ResponseCache.clear()
        Outbox.shared.clear()
        client = nil
        me = nil
        accounts = []
        inboxCount = 0
        pending = nil
        phase = .signedOut
    }

    // MARK: Face ID lock

    private func setBiometricFlag(_ on: Bool) {
        biometricLock = on
        UserDefaults.standard.set(on, forKey: "biometricLock")
    }

    /// A verified app code is needed to change the biometric shortcut.
    func setBiometricLock(_ on: Bool, code: String) async throws {
        guard phase == .ready else { return }
        let credential = try AppPasscode.unlock(code: code)
        let generation = sessionGeneration
        if on {
            _ = try await Biometrics.authenticate(reason: "Включить разблокировку через \(Biometrics.name)")
            guard generation == sessionGeneration, phase == .ready else { return }
            try Keychain.save(credential, biometric: true)
        } else { Keychain.delete() }
        setBiometricFlag(on)
    }

    func didEnterBackground() {
        backgroundedAt = .now
    }

    func didBecomeActive() async {
        defer { backgroundedAt = nil }
        if AppPasscode.isConfigured, phase == .ready, let since = backgroundedAt,
           Date.now.timeIntervalSince(since) > Self.lockAfter {
            sessionGeneration += 1
            client = nil
            phase = .locked
            return
        }
        if phase == .ready { await refreshShared() }
    }

    // MARK: Shared data

    func refreshShared() async {
        guard let client else { return }
        await checkForUpdates()
        await Outbox.shared.flush(with: client)
        if let list: [Account] = try? await client.get("/api/accounts") { accounts = list }
        if let inbox: Inbox = try? await client.get("/api/inbox") {
            inboxCount = inbox.events.count
            if let newest = inbox.events.last?.id { Notifier.markSeen(upTo: newest) }
        }
    }

    func kind(of name: String?) -> String {
        accounts.first { $0.name == name }?.kind ?? "agent"
    }

    /// Signs out when the session stopped working, and returns a message to show otherwise.
    func message(for error: Error) -> String {
        if case APIError.unauthorized = error { signOut() }
        if error.isConnectivity { return APIError.offline.localizedDescription }
        return error.localizedDescription
    }

    // MARK: Navigation from outside

    func open(_ destination: Destination) {
        switch destination {
        case .tab(let target):
            tab = target
        case .task, .newTask, .board:
            tab = .tasks
            pending = destination
        case .project:
            tab = .projects
            pending = destination
        }
    }
}
