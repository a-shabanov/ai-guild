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
    }
}

struct LockView: View {
    @Environment(AppState.self) private var state
    @State private var error: String?
    @State private var busy = false
    @State private var confirming = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "lock.fill")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("AI Tracker").font(.title.bold())
            ErrorBanner(message: error)
                .multilineTextAlignment(.center)
            Spacer()
            Button {
                Task { await unlock() }
            } label: {
                Label("Войти с \(Biometrics.name)", systemImage: Biometrics.icon)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy)
            Button("Войти по ключу") { confirming = true }
                .padding(.bottom)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.appSurface)
        .task { await unlock() }
        .confirmationDialog("Выйти и войти по ключу?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Выйти", role: .destructive) { state.signOut() }
        } message: {
            Text("Сохранённый вход и неотправленные комментарии будут удалены с этого устройства.")
        }
    }

    private func unlock() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await state.unlock()
            error = nil
        } catch let failure as BiometricError where failure.cancelled {
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
