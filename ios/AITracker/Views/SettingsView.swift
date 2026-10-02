import SwiftUI

private struct TwoFactorEnrollmentView: View {
    let channel: String
    let client: APIClient
    let completed: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var phone = ""
    @State private var code = ""
    @State private var token: String?
    @State private var hint: String?
    @State private var error: String?
    @State private var busy = false
    @State private var resendAt = Date.distantPast

    var body: some View {
        NavigationStack {
            ThemedList {
                Section {
                    if channel == "email" {
                        TextField("you@example.com", text: $email)
                            .keyboardType(.emailAddress).textContentType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    } else {
                        TextField("+79991234567", text: $phone)
                            .keyboardType(.phonePad).textContentType(.telephoneNumber)
                        Text("Укажите номер в Telegram с кодом страны. Нажимая «Получить код», вы соглашаетесь получать коды входа в официальном чате Telegram Verification Codes.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let remaining = max(0, Int(resendAt.timeIntervalSince(context.date).rounded(.up)))
                        Button(remaining > 0 ? "Повторить через \(remaining) с" : token == nil ? "Получить код" : "Отправить снова") {
                            Task { await run {
                                var body: [String: JSONValue] = ["channel": .string(channel)]
                                if channel == "email" { body["email"] = .string(email) }
                                else { body["phone"] = .string(phone) }
                                let sent: TwoFactorSent = try await client.send("POST", "/api/auth/2fa/enroll", body: body)
                                token = sent.enrollmentToken
                                hint = "Код отправлен: \(sent.masked). Действует 5 минут."
                                resendAt = Date().addingTimeInterval(TimeInterval(sent.resendAfter))
                            } }
                        }.disabled(busy || remaining > 0 || (channel == "email" ? email.isEmpty : phone.isEmpty))
                    }
                } footer: { Text("Второй шаг включится только после подтверждения кода. Другие устройства потребуется авторизовать заново.") }
                if let token {
                    Section {
                        TextField("Код из шести цифр", text: $code)
                            .keyboardType(.numberPad).textContentType(.oneTimeCode)
                        if let hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
                        Button("Включить 2FA") {
                            Task { await run {
                                let _: OK = try await client.send("POST", "/api/auth/2fa/enroll/verify", body: [
                                    "enrollment_token": .string(token), "code": .string(code),
                                ])
                                completed()
                                dismiss()
                            } }
                        }.disabled(busy || code.count != 6)
                    }
                }
                ErrorBanner(message: error)
            }
            .navigationTitle(channel == "email" ? "Коды по email" : "Коды в Telegram")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() }.disabled(busy) } }
        }
    }
    private func run(_ action: () async throws -> Void) async {
        busy = true; error = nil
        defer { busy = false }
        do { try await action() } catch { self.error = error.localizedDescription }
    }
}

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
    @State private var secondFactor: TwoFactorSettings?
    @State private var enrollingFactor: String?
    @State private var removingFactor: TwoFactorMethod?
    @State private var devices: [AccountDevice] = []
    @State private var deviceError: String?
    @State private var renamingDevice: AccountDevice?
    @State private var deviceName = ""
    @State private var revokingDevice: AccountDevice?
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
                        ForEach(devices) { device in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(device.name).font(.headline)
                                    if device.current { Text("Это устройство").font(.caption).foregroundStyle(.secondary) }
                                }
                                Text(device.clientLabel).font(.caption).foregroundStyle(.secondary)
                                HStack {
                                    Text(device.lastUsedAt, style: .relative)
                                    Text("Сессий: \(device.sessions)")
                                }.font(.caption).foregroundStyle(.secondary)
                                HStack {
                                    Button("Переименовать") { deviceName = device.name; renamingDevice = device }
                                    Button("Завершить входы", role: .destructive) { revokingDevice = device }
                                }.disabled(busy)
                            }
                        }
                        if let deviceError { Text(deviceError).font(.caption).foregroundStyle(.secondary) }
                    } header: { Text("Устройства") }
                    footer: { Text("Один браузер или установка приложения — одно устройство. Повторные входы объединяются.") }
                    Section {
                        Text(secondFactor?.enabled == true ? "После входа потребуется код по одному из подключённых каналов." : "Дополнительное подтверждение входа кодом включается по желанию.")
                            .font(.caption).foregroundStyle(.secondary)
                        if let settings = secondFactor {
                            ForEach(["email", "telegram"], id: \.self) { channel in
                                let method = settings.methods.first { $0.channel == channel }
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(channel == "email" ? "Email" : "Telegram")
                                    Text(method?.masked ?? "Не подключён").font(.caption).foregroundStyle(.secondary)
                                    HStack {
                                        Button(method == nil ? "Подключить" : "Сменить") { enrollingFactor = channel }
                                            .disabled(busy || !settings.available.enabled(channel))
                                        if let method { Button("Отключить", role: .destructive) { removingFactor = method }.disabled(busy) }
                                    }
                                }
                            }
                            if !settings.available.email && !settings.available.telegram {
                                Text("Отправка кодов пока не настроена администратором.").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    } header: { Text("Двухэтапный вход") }
                    footer: { Text("Добавьте оба канала для запасного способа подтверждения. Для изменения 2FA может потребоваться войти заново.") }
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
                await loadSecondFactor()
                await loadDevices()
            }
            .task {
                await loadPasskeys()
                await loadIdentities()
                await loadSecondFactor()
                await loadDevices()
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
            .alert("Имя устройства", isPresented: Binding(get: { renamingDevice != nil }, set: { if !$0 { renamingDevice = nil } })) {
                TextField("Имя устройства", text: $deviceName)
                Button("Сохранить") {
                    guard let device = renamingDevice else { return }
                    run {
                        guard let client = state.client else { return }
                        let _: DeviceRenameResponse = try await client.send("PATCH", "/api/devices/\(device.id)", body: ["name": .string(deviceName)])
                        renamingDevice = nil
                        await loadDevices()
                    }
                }
                Button("Отмена", role: .cancel) { renamingDevice = nil }
            }
            .confirmationDialog("Завершить входы на устройстве?", isPresented: Binding(get: { revokingDevice != nil }, set: { if !$0 { revokingDevice = nil } }), titleVisibility: .visible) {
                if let device = revokingDevice {
                    Button("Завершить входы", role: .destructive) {
                        run {
                            guard let client = state.client else { return }
                            let _: OK = try await client.send("DELETE", "/api/devices/\(device.id)")
                            revokingDevice = nil
                            if device.current { state.signOut() } else { await loadDevices() }
                        }
                    }
                }
            } message: { Text("Все сессии этого устройства завершатся, уведомления будут отключены. Для продолжения потребуется войти снова.") }
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
            .sheet(isPresented: Binding(get: { enrollingFactor != nil }, set: { if !$0 { enrollingFactor = nil } })) {
                if let channel = enrollingFactor, let client = state.client {
                    TwoFactorEnrollmentView(channel: channel, client: client) {
                        enrollingFactor = nil
                        Task { await loadSecondFactor() }
                    }
                }
            }
            .confirmationDialog("Отключить коды?", isPresented: Binding(get: { removingFactor != nil }, set: { if !$0 { removingFactor = nil } }), titleVisibility: .visible) {
                if let method = removingFactor {
                    Button("Отключить \(method.title)", role: .destructive) {
                        run {
                            guard let client = state.client else { return }
                            let _: OK = try await client.send("DELETE", "/api/auth/2fa/settings/\(method.channel)")
                            removingFactor = nil
                            await loadSecondFactor()
                        }
                    }
                }
            }
        }
    }

    private func loadSecondFactor() async {
        secondFactor = try? await state.client?.get("/api/auth/2fa/settings")
    }
    private struct DeviceRenameResponse: Decodable { let id: Int; let name: String }
    private func loadDevices() async {
        guard state.me?.isAgent == false, let client = state.client else { return }
        do { devices = try await client.get("/api/devices"); deviceError = nil }
        catch { deviceError = error.localizedDescription }
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
