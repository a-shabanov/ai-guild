import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var state
    @State private var server = ""
    @State private var key = ""
    @State private var error: String?
    @State private var busy = false
    @State private var providers: SignInProviders?

    var body: some View {
        NavigationStack {
            ThemedList {
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
            .navigationTitle("AI Tracker")
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
