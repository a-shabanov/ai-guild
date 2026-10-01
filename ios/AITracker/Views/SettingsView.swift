import SwiftUI

/// "0.2.0 (7)": the version and the build number, set by scripts/version.mjs.
enum AppVersion {
    static var current: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}

struct SettingsView: View {
    @Environment(AppState.self) private var state
    @State private var confirming = false
    @State private var error: String?
    @State private var notifications = Notifier.isEnabled
    @State private var passkeys: [Passkey] = []
    @State private var busy = false
    @State private var server: String?
    @State private var identities: [SocialIdentity] = []
    @State private var providers: SignInProviders?
    @State private var removingIdentity: SocialIdentity?
    @AppStorage(AppTheme.key) private var theme = AppTheme.system

    var body: some View {
        NavigationStack {
            ThemedList {
                if let me = state.me {
                    Section("Аккаунт") {
                        HStack {
                            Avatar(name: me.name, kind: me.kind)
                            Text(me.name)
                            Spacer()
                            Text(me.role == "admin" ? "Администратор" : "Участник")
                                .foregroundStyle(.secondary)
                        }
                        LabeledContent("Сервер", value: state.serverURL)
                    }
                }

                if state.me?.isAgent == false {
                    Section {
                        ForEach(["google", "telegram"], id: \.self) { provider in
                            let identity = identities.first { $0.provider == provider }
                            let name = provider == "google" ? "Google" : "Telegram"
                            VStack(alignment: .leading, spacing: 6) {
                                Text(name)
                                if let identity {
                                    Text(identity.label).font(.caption).foregroundStyle(.secondary)
                                    Button("Отключить", role: .destructive) { removingIdentity = identity }
                                        .disabled(busy)
                                } else {
                                    Button("Привязать \(name)") {
                                        run {
                                            guard let client = state.client else { return }
                                            _ = try await SocialLogin.shared.authorize(provider: provider, client: client, linking: true)
                                            await loadIdentities()
                                        }
                                    }
                                    .disabled(busy || providers?.enabled(provider) != true)
                                    if providers?.enabled(provider) != true {
                                        Text("Не настроен администратором").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    } header: { Text("Способы входа") }
                    footer: { Text("Google и Telegram общие с веб-версией. Отключение способа завершает сессии, созданные через него.") }
                }

                Section {
                    Picker("Тема", selection: $theme) {
                        ForEach(AppTheme.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Оформление")
                } footer: {
                    Text("«Как в системе» меняется вместе с телефоном, в том числе по расписанию на ночь.")
                }

                Section {
                    Toggle(isOn: Binding(
                        get: { state.biometricLock },
                        set: { on in run { try await state.setBiometricLock(on) } }
                    )) {
                        Label("Вход по \(Biometrics.name)", systemImage: Biometrics.icon)
                    }
                    .disabled(busy || (!Biometrics.isAvailable && !state.biometricLock))
                } header: {
                    Text("Защита")
                } footer: {
                    Text(Biometrics.isAvailable || state.biometricLock
                        ? "Сессия хранится в связке ключей и выдаётся только после проверки \(Biometrics.name). Приложение блокируется через минуту в фоне."
                        : "\(Biometrics.name) не настроен на этом устройстве.")
                }

                if Passkeys.isAvailable(for: state.serverURL) {
                    Section {
                        ForEach(passkeys) { passkey in
                            VStack(alignment: .leading) {
                                Text(passkey.name)
                                Text(passkey.lastUsedAt.map { "Вход \(Format.ago($0))" } ?? "Ещё не использовался")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .swipeActions {
                                Button("Удалить", role: .destructive) { remove(passkey) }
                            }
                        }
                        Button("Добавить passkey", systemImage: "person.badge.key") {
                            run {
                                guard let client = state.client else { return }
                                try await Passkeys.shared.register(with: client, name: UIDevice.current.name)
                                await loadPasskeys()
                            }
                        }
                        .disabled(busy)
                    } header: {
                        Text("Passkeys")
                    } footer: {
                        Text("Общие с веб-версией: созданный здесь passkey подходит и для входа в браузере.")
                    }
                }

                Section {
                    Toggle(isOn: Binding(
                        get: { notifications },
                        set: { on in
                            run {
                                if on {
                                    notifications = try await Notifier.enable()
                                    if !notifications {
                                        error = "Уведомления запрещены. Разрешите их в Настройках iOS."
                                    }
                                } else {
                                    await Notifier.disable(client: state.client)
                                    notifications = false
                                }
                            }
                        }
                    )) {
                        Label("Уведомления", systemImage: "bell")
                    }
                    .disabled(busy)
                } footer: {
                    Text("Когда агент сдал результат, ответил в вашей задаче или упомянул вас.")
                }

                ErrorBanner(message: error)

                Section {
                    ForEach(state.accounts) { account in
                        HStack {
                            Avatar(name: account.name, kind: account.kind)
                            VStack(alignment: .leading) {
                                Text(account.name)
                                Text([account.isAgent ? "Агент" : "Человек", account.system]
                                    .compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if account.disabled {
                                Text("отключён").font(.caption).foregroundStyle(.secondary)
                            } else if let seen = account.lastSeenAt {
                                Text(Format.ago(seen)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .opacity(account.disabled ? 0.5 : 1)
                    }
                } header: {
                    Text("Участники")
                } footer: {
                    Text("Новые аккаунты и ключи для агентов создаются в веб-версии.")
                }

                Section("О приложении") {
                    LabeledContent("Версия", value: AppVersion.current)
                    if let server {
                        LabeledContent("Сервер", value: server)
                    }
                }

                Section {
                    Button("Выйти", role: .destructive) { confirming = true }
                }
            }
            .navigationTitle("Настройки")
            .refreshable {
                await state.refreshShared()
                await loadPasskeys()
                await loadIdentities()
            }
            .task {
                await loadPasskeys()
                await loadIdentities()
                let config: ServerConfig? = try? await state.client?.get("/api/config")
                providers = config?.providers
                if let version = config?.version, let build = config?.build { server = "\(version) (\(build))" }
            }
            .confirmationDialog("Выйти из аккаунта?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Выйти", role: .destructive) { state.signOut() }
            } message: {
                Text(Outbox.shared.items.isEmpty
                    ? "Сессия будет завершена и удалена с этого устройства."
                    : "Сессия будет завершена. Неотправленные комментарии (\(Outbox.shared.items.count)) будут удалены.")
            }
            .confirmationDialog("Отключить способ входа?", isPresented: Binding(
                get: { removingIdentity != nil }, set: { if !$0 { removingIdentity = nil } }
            ), titleVisibility: .visible) {
                if let identity = removingIdentity {
                    Button("Отключить", role: .destructive) {
                        run {
                            guard let client = state.client else { return }
                            let _: OK = try await client.send("DELETE", "/api/auth/identities/\(identity.provider)")
                            let _: Account = try await client.get("/api/me")
                            await loadIdentities()
                        }
                    }
                }
            } message: { Text("Сессии через этот способ завершатся. Убедитесь, что у вас есть другой способ входа, passkey или новое приглашение администратора.") }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            busy = true
            error = nil
            defer { busy = false }
            do {
                try await action()
            } catch let failure as BiometricError where failure.cancelled {
            } catch {
                self.error = state.message(for: error)
            }
        }
    }

    private func loadPasskeys() async {
        guard Passkeys.isAvailable(for: state.serverURL), let client = state.client else { return }
        if let list: [Passkey] = try? await client.get("/api/passkeys") { passkeys = list }
    }

    private func loadIdentities() async {
        if let list: [SocialIdentity] = try? await state.client?.get("/api/auth/identities") { identities = list }
    }

    private func remove(_ passkey: Passkey) {
        run {
            guard let client = state.client else { return }
            let _: OK = try await client.send("DELETE", "/api/passkeys/\(passkey.id)")
            await loadPasskeys()
        }
    }
}
