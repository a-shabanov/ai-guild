import SwiftUI

/// How the app looks, whatever the rest of the phone does.
enum AppTheme: String, CaseIterable, Identifiable {
    case system, light, dark

    static let key = "theme"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "Как в системе"
        case .light: "Светлое"
        case .dark: "Тёмное"
        }
    }

    var scheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

@main
struct AITrackerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var state = AppState.shared
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppTheme.key) private var theme = AppTheme.system

    init() {
        Palette.applyToUIKit()
    }

    var body: some Scene {
        WindowGroup {
            Group {
                switch state.phase {
                case .restoring: ProgressView()
                case .signedOut: LoginView()
                case .settingPasscode: PasscodeSetupView()
                case .offeringQuickUnlock: QuickUnlockOfferView()
                case .locked: LockView()
                case .ready: RootView()
                }
            }
            .environment(state)
            .preferredColorScheme(theme.scheme)
            .task { await state.restore() }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: state.didEnterBackground()
            case .active: Task { await state.didBecomeActive() }
            default: break
            }
        }
        .backgroundTask(.appRefresh(Notifier.refreshTask)) {
            await Notifier.refreshInBackground()
        }
    }
}

struct RootView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        @Bindable var state = state
        TabView(selection: $state.tab) {
            ProjectsView()
                .tabItem { Label("Проекты", systemImage: "square.grid.2x2") }
                .tag(AppTab.projects)
            TasksView()
                .tabItem { Label("Задачи", systemImage: "checklist") }
                .tag(AppTab.tasks)
            InboxView()
                .tabItem { Label("Входящие", systemImage: "tray") }
                .badge(state.inboxCount)
                .tag(AppTab.inbox)
            AnalyticsView()
                .tabItem { Label("Аналитика", systemImage: "chart.bar") }
                .tag(AppTab.analytics)
            SettingsView()
                .tabItem { Label("Настройки", systemImage: "gearshape") }
                .badge(state.availableUpdate == nil ? nil : "•")
                .tag(AppTab.settings)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if Connectivity.shared.offline {
                Label("Нет сети — показаны сохранённые данные", systemImage: "wifi.slash")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.black)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(Color.yellow)
            }
        }
        .animation(.default, value: Connectivity.shared.offline)
        .alert("Защита приложения", isPresented: Binding(
            get: { state.securityNotice != nil },
            set: { if !$0 { state.securityNotice = nil } }
        )) {
            Button("Понятно") { state.securityNotice = nil }
        } message: { Text(state.securityNotice ?? "") }
    }
}

struct LockView: View {
    @Environment(AppState.self) private var state
    @State private var digits = ""
    @State private var error: String?
    @State private var busy = false
    @State private var confirming = false

    var body: some View {
        CodeEntryView(title: "Введите код-пароль",
            subtitle: "Разблокировать приложение",
            digits: $digits, error: error, busy: busy,
            biometric: state.biometricLock ? { Task { await unlock() } } : nil,
            canType: AppPasscode.isConfigured,
            completed: { Task { await unlock(code: digits) } }) {
                Button("Забыли код-пароль?") { confirming = true }.font(.footnote).disabled(busy)
        }
        .task { if state.biometricLock { await unlock() } }
        .confirmationDialog("Выйти из аккаунта и сбросить код-пароль?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Выйти", role: .destructive) { state.signOut() }
        } message: {
            Text("Войдите заново через passkey, Google, Telegram или API-ключ. Неотправленные комментарии будут удалены с этого устройства.")
        }
    }

    private func unlock(code: String? = nil) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false; digits = "" }
        do {
            if let code { try await state.unlock(code: code) }
            else { try await state.unlock() }
        } catch let failure as BiometricError where failure.cancelled {
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}
