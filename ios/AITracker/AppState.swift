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
        case restoring, signedOut, locked, ready
    }

    private(set) var phase = Phase.restoring
    private(set) var client: APIClient?
    private(set) var me: Account?
    private(set) var accounts: [Account] = []
    var inboxCount = 0 {
        didSet { Notifier.setBadge(inboxCount) }
    }

    var tab = AppTab.projects
    /// Consumed by the tasks screen once it is on screen.
    var pending: Destination?

    private(set) var biometricLock = UserDefaults.standard.bool(forKey: "biometricLock")
    private var backgroundedAt: Date?
    private static let lockAfter: TimeInterval = 60

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
            // AITRACKER_LOCK=1 does what the Face ID switch in Settings does.
            if env["AITRACKER_LOCK"] == "1" {
                // The Face ID sheet needs the window to be on screen first.
                try? await Task.sleep(for: .seconds(2))
                try? await setBiometricLock(true)
            }
            return
        }
        #endif
        if biometricLock {
            phase = .locked
            return
        }
        guard let credential = Keychain.load() else {
            phase = .signedOut
            return
        }
        await connect(credential: credential)
    }

    func unlock() async throws {
        let context = try await Biometrics.authenticate(reason: "Вход в AI Guild")
        guard let credential = Keychain.load(context: context) else {
            // Face ID was re-enrolled: iOS discarded the item bound to the old enrollment.
            signOut()
            throw APIError.server("Данные \(Biometrics.name) изменились. Войдите по ключу ещё раз.")
        }
        await connect(credential: credential)
    }

    private func connect(credential: String) async {
        guard let url = URL(string: serverURL) else {
            phase = .signedOut
            return
        }
        let candidate = APIClient(baseURL: url, key: credential)
        do {
            me = try await candidate.get("/api/me")
            client = candidate
            phase = .ready
            Notifier.resume()
            await refreshShared()
        } catch APIError.unauthorized {
            signOut()
        } catch {
            // Server unreachable and nothing saved to show. The credential stays for next time.
            phase = .signedOut
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
        Keychain.save(token, biometric: false)
        setBiometricFlag(false)
        client = candidate
        me = account
        phase = .ready
        Notifier.resume()
        await refreshShared()
    }

    /// Trades the API key for a revocable session, so the key itself is never stored.
    func signIn(server: String, key: String) async throws {
        let url = try parse(server: server)
        let anonymous = APIClient(baseURL: url, key: "")
        do {
            let session: SessionResponse = try await anonymous.send("POST", "/api/session", body: [
                "key": .string(key.trimmingCharacters(in: .whitespacesAndNewlines)),
            ])
            try await adopt(server: url, token: session.sessionToken)
        } catch where error.isConnectivity {
            // On the sign-in screen the address is the usual suspect: say which one was tried and why it failed.
            let reason = (error as? URLError)?.localizedDescription ?? ""
            throw APIError.server("Нет соединения с \(url.absoluteString). \(reason)")
        }
    }

    func signInWithPasskey(server: String) async throws {
        let url = try parse(server: server)
        try await adopt(server: url, token: try await Passkeys.shared.signIn(server: url))
    }

    func signInWithProvider(server: String, provider: String) async throws {
        let url = try parse(server: server)
        let anonymous = APIClient(baseURL: url, key: "")
        guard let token = try await SocialLogin.shared.authorize(provider: provider, client: anonymous) else {
            throw APIError.server("Не удалось получить сессию")
        }
        try await adopt(server: url, token: token)
    }

    func signOut() {
        if let client {
            Task {
                if let token = Notifier.deviceToken {
                    let _: OK? = try? await client.send("DELETE", "/api/push/apns", body: ["token": .string(token)])
                }
                let _: OK? = try? await client.send("DELETE", "/api/session")
            }
        }
        Keychain.delete()
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

    /// Both directions ask for the face first: turning the lock off is as sensitive as using it.
    func setBiometricLock(_ on: Bool) async throws {
        guard let client else { return }
        _ = try await Biometrics.authenticate(
            reason: on ? "Включить вход по \(Biometrics.name)" : "Отключить вход по \(Biometrics.name)")
        Keychain.save(client.key, biometric: on)
        setBiometricFlag(on)
    }

    func didEnterBackground() {
        backgroundedAt = .now
    }

    func didBecomeActive() async {
        defer { backgroundedAt = nil }
        if biometricLock, phase == .ready, let since = backgroundedAt,
           Date.now.timeIntervalSince(since) > Self.lockAfter {
            client = nil
            phase = .locked
            return
        }
        if phase == .ready { await refreshShared() }
    }

    // MARK: Shared data

    func refreshShared() async {
        guard let client else { return }
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
