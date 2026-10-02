import SwiftUI

struct LoginView: View {
    @State private var secondFactorCode = ""
    @State private var secondFactorHint: String?
    @State private var resendAt = Date.distantPast
    @Environment(AppState.self) private var state
    @State private var server = ""
    @State private var key = ""
    @State private var error: String?
    @State private var busy = false
    @State private var providers: SignInProviders?

    var body: some View {
        NavigationStack {
            ThemedList {
                if let challenge = state.secondFactor {
                    Section {
                        Text("Первый шаг пройден. Подтвердите вход одноразовым кодом.")
                        ForEach(challenge.methods ?? []) { method in
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                let remaining = max(0, Int(resendAt.timeIntervalSince(context.date).rounded(.up)))
                                Button(remaining > 0 ? "Повторить через \(remaining) с" : method.channel == "telegram" ? method.masked : "\(method.title) · \(method.masked)") {
                                    Task { await run {
                                        let sent = try await state.sendSecondFactor(channel: method.channel)
                                        secondFactorHint = "Код отправлен: \(sent.masked). Действует 5 минут."
                                        resendAt = Date().addingTimeInterval(TimeInterval(sent.resendAfter))
                                    } }
                                }
                                .disabled(busy || !method.available || remaining > 0)
                            }
                        }
                        if (challenge.methods ?? []).allSatisfy({ !$0.available }) {
                            Text("Отправка кодов недоступна. Обратитесь к администратору.").foregroundStyle(.secondary)
                        }
                    } header: { Text("Подтвердите вход") }
                    Section {
                        TextField("Код из шести цифр", text: $secondFactorCode)
                            .keyboardType(.numberPad).textContentType(.oneTimeCode)
                        if let secondFactorHint { Text(secondFactorHint).font(.caption).foregroundStyle(.secondary) }
                        Button("Подтвердить вход") {
                            Task { await run { try await state.verifySecondFactor(code: secondFactorCode) } }
                        }.disabled(busy || secondFactorCode.count != 6)
                        ErrorBanner(message: error)
                        Button("Другой аккаунт") { state.cancelSecondFactor(); secondFactorCode = ""; secondFactorHint = nil; error = nil; resendAt = .distantPast }
                    }
                } else {
                Section {
                    TextField("http://localhost:4600", text: $server)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Сервер")
                }
                Section {
                    ForEach(["google", "telegram"], id: \.self) { provider in
                        Button("Войти через \(provider == "google" ? "Google" : "Telegram")") {
                            Task { await run { try await state.signInWithProvider(server: server, provider: provider) } }
                        }
                        .disabled(busy || providers?.enabled(provider) != true)
                    }
                } header: {
                    Text("Вход")
                } footer: {
                    Text("Первый вход — по ссылке-приглашению администратора в браузере. После привязки можно войти здесь через Google или Telegram.")
                }
                Section {
                    SecureField("ait_…", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("API-ключ")
                } footer: {
                    Text("Ключ нужен один раз: приложение меняет его на сессию и хранит в связке ключей только её.")
                }
                Section {
                    Button {
                        Task { await run { try await state.signIn(server: server, key: key) } }
                    } label: {
                        HStack {
                            Text("Войти по ключу")
                            if busy { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy || key.isEmpty || server.isEmpty)
                    if Passkeys.isAvailable(for: server) {
                        Button {
                            Task { await run { try await state.signInWithPasskey(server: server) } }
                        } label: {
                            Label("Войти с passkey", systemImage: "person.badge.key")
                        }
                        .disabled(busy)
                    }
                    ErrorBanner(message: error)
                } footer: {
                    Text("После входа в настройках можно включить \(Biometrics.name), чтобы не вводить ключ.")
                }
                }
            }
            .navigationTitle("AI Guild")
            .onAppear { if server.isEmpty { server = state.serverURL } }
            .task(id: server) {
                providers = nil
                let requested = server
                try? await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled, let url = URL(string: requested) else { return }
                let config: ServerConfig? = try? await APIClient(baseURL: url, key: "").get("/api/config")
                if server == requested { providers = config?.providers }
            }
        }
    }

    private func run(_ action: () async throws -> Void) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await action()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
