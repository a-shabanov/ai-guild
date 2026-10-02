import SwiftUI

/// One keypad for setup, fallback unlock and authenticated settings changes.
struct CodeEntryView<Extra: View>: View {
    let title: String
    let subtitle: String
    @Binding var digits: String
    let error: String?
    let busy: Bool
    var biometric: (() -> Void)? = nil
    var canType = true
    let completed: () -> Void
    @ViewBuilder var extra: () -> Extra

    var body: some View {
        VStack(spacing: 20) {
            Spacer(minLength: 12)
            Image(systemName: "lock.shield")
                .font(.system(size: 36, weight: .light)).foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("AI Guild").font(.title2.bold())
            VStack(spacing: 8) {
                Text(title).font(.title3.weight(.semibold))
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 16) {
                ForEach(0..<6) { index in
                    Circle().fill(index < digits.count ? Color.accentColor : Color.secondary.opacity(0.18))
                        .frame(width: 13, height: 13)
                }
            }
            .padding(.vertical, 8)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Введено \(digits.count) из шести цифр")
            Text(error ?? " ").font(.footnote).foregroundStyle(.red)
                .multilineTextAlignment(.center).frame(minHeight: 32)
                .accessibilityAddTraits(.updatesFrequently)
            extra()
            Spacer(minLength: 12)
            VStack(spacing: 12) {
                ForEach(0..<3) { row in
                    HStack(spacing: 22) {
                        ForEach(1..<4) { column in digit(row * 3 + column) }
                    }
                }
                HStack(spacing: 22) {
                    Button { biometric?() } label: {
                        Image(systemName: Biometrics.icon).font(.system(size: 28)).frame(width: 74, height: 62)
                    }
                    .accessibilityLabel("Разблокировать через \(Biometrics.name)")
                    .opacity(biometric == nil ? 0 : 1).disabled(busy || biometric == nil)
                    digit(0)
                    Button { if !digits.isEmpty { digits.removeLast() } } label: {
                        Image(systemName: "delete.left").font(.system(size: 23)).frame(width: 74, height: 62)
                    }
                    .accessibilityLabel("Удалить цифру").disabled(busy || digits.isEmpty)
                }
            }
            .buttonStyle(.plain)
            if busy { ProgressView().frame(height: 20) }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.appSurface)
        .onChange(of: digits) { _, value in if value.count == 6 { completed() } }
    }

    private func digit(_ value: Int) -> some View {
        Button { if digits.count < 6 { digits += String(value) } } label: {
            Text(String(value)).font(.system(size: 30, weight: .regular, design: .rounded))
                .frame(width: 74, height: 62)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 20))
        }
        .accessibilityLabel(String(value)).disabled(busy || !canType)
    }
}

struct PasscodeSetupView: View {
    @Environment(AppState.self) private var state
    @State private var digits = ""
    @State private var first = ""
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        CodeEntryView(title: first.isEmpty ? "Создайте код-пароль" : "Повторите код-пароль",
            subtitle: "Шесть цифр для доступа к приложению на этом устройстве",
            digits: $digits, error: error, busy: busy, completed: complete) {
                Text("PIN можно установить позже в настройках защиты приложения.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("Пропустить") {
                    guard !busy else { return }
                    busy = true
                    Task {
                        defer { busy = false }
                        do { try await state.skipPasscodeSetup() }
                        catch { self.error = error.localizedDescription }
                    }
                }.font(.footnote).disabled(busy)
                Button("Начать заново") {
                    first = ""; digits = ""; error = nil
                }.font(.footnote).disabled(busy).opacity(first.isEmpty ? 0 : 1)
        }
    }
    private func complete() {
        guard !busy else { return }
        error = nil
        if first.isEmpty { first = digits; digits = ""; return }
        guard digits == first else { error = "Коды не совпадают. Повторите код-пароль"; digits = ""; return }
        busy = true
        Task {
            defer { busy = false; digits = "" }
            do { try state.createPasscode(first) }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct PasscodeSettingsView: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    let biometric: Bool? // nil changes the code; true/false changes the shortcut.
    @State private var digits = ""
    @State private var current = ""
    @State private var first = ""
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        CodeEntryView(title: current.isEmpty ? "Введите текущий код-пароль" : first.isEmpty ? "Новый код-пароль" : "Повторите новый код-пароль",
            subtitle: biometric.map { $0 ? "Включить \(Biometrics.name) для разблокировки" : "Отключить \(Biometrics.name) для разблокировки" } ?? "Изменить защиту приложения",
            digits: $digits, error: error, busy: busy, completed: complete) {
                Button("Отмена") { dismiss() }.disabled(busy)
        }
        .interactiveDismissDisabled(busy)
    }
    private func complete() {
        guard !busy else { return }
        error = nil
        if current.isEmpty {
            let code = digits; busy = true
            Task {
                defer { busy = false; digits = "" }
                do {
                    if let biometric { try await state.setBiometricLock(biometric, code: code); dismiss() }
                    else { _ = try AppPasscode.unlock(code: code); current = code }
                } catch { self.error = error.localizedDescription }
            }
        } else if first.isEmpty { first = digits; digits = "" }
        else if digits != first { error = "Коды не совпадают"; digits = "" }
        else {
            do { try state.changePasscode(current: current, new: first); dismiss() }
            catch { self.error = error.localizedDescription; digits = "" }
        }
    }
}

struct QuickUnlockOfferView: View {
    @Environment(AppState.self) private var state
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: Biometrics.icon).font(.system(size: 64, weight: .light))
                .foregroundStyle(.tint).accessibilityHidden(true)
            Text("Подключить быструю разблокировку?").font(.title2.bold()).multilineTextAlignment(.center)
            Text("PIN-код сохранён. \(Biometrics.name) позволит открывать приложение без его ввода.")
                .foregroundStyle(.secondary).multilineTextAlignment(.center)
            if !Biometrics.isAvailable {
                Text("Быстрая разблокировка недоступна на этом устройстве. Её можно подключить позже в настройках.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center) }
            Spacer()
            Button("Подключить") { finish(enable: true) }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(busy || !Biometrics.isAvailable)
            Button("Не сейчас") { finish(enable: false) }.disabled(busy)
            if busy { ProgressView() }
        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.appSurface)
    }
    private func finish(enable: Bool) {
        guard !busy else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await state.finishQuickUnlock(enable: enable) }
            catch let failure as BiometricError where failure.cancelled { error = nil }
            catch { self.error = error.localizedDescription }
        }
    }
}
