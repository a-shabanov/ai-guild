import BackgroundTasks
import UIKit
import UserNotifications

/// Notifications, the icon badge and home-screen shortcuts.
///
/// Remote push (APNs) is used when this build and the server are configured for it. Otherwise
/// the app checks the inbox during background refresh and posts local notifications, which
/// iOS schedules at its own discretion and which cannot run while the Face ID lock is on
/// (the credential is unreadable without the owner's face).
@MainActor
enum Notifier {
    static let refreshTask = "dev.aitracker.app.refresh"
    private static let enabledKey = "notificationsEnabled"
    private static let lastEventKey = "lastNotifiedEvent"
    private static let deviceTokenKey = "apnsToken"

    static var isEnabled: Bool { UserDefaults.standard.bool(forKey: enabledKey) }
    static var deviceToken: String? { UserDefaults.standard.string(forKey: deviceTokenKey) }

    #if DEBUG
    static let apnsEnvironment = "sandbox"
    #else
    static let apnsEnvironment = "production"
    #endif

    /// - Returns: false when the person declined.
    static func enable() async throws -> Bool {
        let granted = try await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .badge, .sound])
        UserDefaults.standard.set(granted, forKey: enabledKey)
        if granted {
            UIApplication.shared.registerForRemoteNotifications()
            scheduleRefresh()
        }
        return granted
    }

    static func disable(client: APIClient?) async {
        UserDefaults.standard.set(false, forKey: enabledKey)
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: refreshTask)
        UIApplication.shared.unregisterForRemoteNotifications()
        if let token = deviceToken, let client {
            let _: OK? = try? await client.send("DELETE", "/api/push/apns", body: ["token": .string(token)])
        }
        UserDefaults.standard.removeObject(forKey: deviceTokenKey)
        setBadge(0)
    }

    static func resume() {
        guard isEnabled else { return }
        UIApplication.shared.registerForRemoteNotifications()
        scheduleRefresh()
    }

    static func register(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: deviceTokenKey)
        guard let client = AppState.shared.client else { return }
        Task {
            let _: OK? = try? await client.send("POST", "/api/push/apns", body: [
                "token": .string(token),
                "environment": .string(apnsEnvironment),
            ])
        }
    }

    static func setBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(max(0, count)) { _ in }
    }

    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTask)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Runs in the background: updates the badge and announces what is new in the inbox.
    static func refreshInBackground() async {
        guard isEnabled else { return }
        scheduleRefresh()
        guard let token = Keychain.load(),
              let server = URL(string: AppState.shared.serverURL) else { return }
        let client = APIClient(baseURL: server, key: token)
        guard let inbox: Inbox = try? await client.get("/api/inbox"),
              !Connectivity.shared.offline else { return }
        setBadge(inbox.events.count)

        // With remote push working, Apple already delivered these.
        let config: ServerConfig? = try? await client.get("/api/config")
        if config?.apns == true, deviceToken != nil { return }

        let last = UserDefaults.standard.integer(forKey: lastEventKey)
        for event in inbox.events where event.id > last {
            let content = UNMutableNotificationContent()
            content.title = "\(event.actorName) · #\(event.taskId) \(event.taskTitle)"
            content.body = event.string("body") ?? event.summary
            content.sound = .default
            content.threadIdentifier = "task-\(event.taskId)"
            content.userInfo = ["task_id": event.taskId]
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "event-\(event.id)", content: content, trigger: nil))
        }
        if let newest = inbox.events.last?.id {
            UserDefaults.standard.set(newest, forKey: lastEventKey)
        }
    }

    /// Events seen in the app itself must not be announced again later.
    static func markSeen(upTo eventId: Int) {
        if eventId > UserDefaults.standard.integer(forKey: lastEventKey) {
            UserDefaults.standard.set(eventId, forKey: lastEventKey)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting session: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: session.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Notifier.register(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Expected in builds without the push entitlement; background refresh covers for it.
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let taskId = (info["task_id"] as? NSNumber)?.intValue else { return }
        await MainActor.run { AppState.shared.open(.task(taskId)) }
    }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(
        _ scene: UIScene, willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        if let item = connectionOptions.shortcutItem { handle(item) }
    }

    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(handle(shortcutItem))
    }

    @discardableResult
    private func handle(_ item: UIApplicationShortcutItem) -> Bool {
        switch item.type {
        case "inbox": AppState.shared.open(.tab(.inbox))
        case "analytics": AppState.shared.open(.tab(.analytics))
        case "new": AppState.shared.open(.newTask)
        default: return false
        }
        return true
    }
}
