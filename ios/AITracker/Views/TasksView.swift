import SwiftUI

struct TasksView: View {
    @Environment(AppState.self) private var state
    @State private var tasks: [TaskItem] = []
    @State private var status = "open"
    @State private var assignee = ""
    @State private var search = ""
    @State private var error: String?
    @State private var loaded = false
    @State private var creating = false
    @State private var path: [Int] = []
    @AppStorage("tasksAsBoard") private var asBoard = false

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if asBoard { BoardView() } else { list }
            }
            .navigationTitle(asBoard ? "Доска" : "Задачи")
            .navigationBarTitleDisplayMode(asBoard ? .inline : .automatic)
            .navigationDestination(for: Int.self) { TaskDetailView(taskId: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Picker("Вид", selection: $asBoard) {
                        Label("Список", systemImage: "list.bullet").tag(false)
                        Label("Доска", systemImage: "rectangle.split.3x1").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 110)
                }
                if !asBoard {
                    ToolbarItem(placement: .topBarTrailing) { filterMenu }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Новая задача", systemImage: "plus") { creating = true }
                }
            }
            .sheet(isPresented: $creating) {
                NewTaskView { id in
                    path.append(id)
                }
            }
            .onChange(of: state.pending, initial: true) { _, destination in
                // Arrived from a notification or a home-screen shortcut.
                switch destination {
                case .task(let id): path = [id]
                case .newTask: creating = true
                case .board: asBoard = true
                default: return
                }
                state.pending = nil
            }
        }
    }

    private var list: some View {
            ThemedList(plain: true) {
                ErrorBanner(message: error)
                ForEach(tasks) { task in
                    NavigationLink(value: task.id) { TaskRow(task: task) }
                }
            }
            .listStyle(.plain)
            .overlay {
                if !loaded {
                    ProgressView()
                } else if tasks.isEmpty && error == nil {
                    ContentUnavailableView("Задач нет", systemImage: "checklist", description: Text("По этим фильтрам ничего не найдено"))
                }
            }
            .searchable(text: $search, prompt: "Поиск")
            .refreshable { await load() }
            .task(id: "\(status)|\(assignee)|\(search)") {
                // Debounce typing in the search field.
                if loaded { try? await Task.sleep(for: .milliseconds(250)) }
                if !Task.isCancelled { await load() }
            }
            .onChange(of: path) { _, new in
                if new.isEmpty { Task { await load() } }
            }
    }

    private var filterMenu: some View {
        Menu {
            Picker("Статус", selection: $status) {
                Text("Открытые").tag("open")
                Text("Все").tag("")
                ForEach(TaskStatus.allCases) { Text($0.title).tag($0.rawValue) }
            }
            Picker("Исполнитель", selection: $assignee) {
                Text("Любой исполнитель").tag("")
                Text("Я").tag("me")
                Text("Не назначен").tag("none")
                ForEach(state.accounts.filter { !$0.disabled }) { Text($0.name).tag($0.name) }
            }
        } label: {
            Label("Фильтры", systemImage: status == "open" && assignee.isEmpty
                ? "line.3.horizontal.decrease.circle"
                : "line.3.horizontal.decrease.circle.fill")
        }
    }

    private func load() async {
        guard let client = state.client else { return }
        var query: [URLQueryItem] = []
        if !status.isEmpty { query.append(.init(name: "status", value: status)) }
        if !assignee.isEmpty { query.append(.init(name: "assignee", value: assignee)) }
        if !search.isEmpty { query.append(.init(name: "q", value: search)) }
        do {
            tasks = try await client.get("/api/tasks", query: query)
            error = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            self.error = state.message(for: error)
        }
        loaded = true
    }
}

struct TaskRow: View {
    @Environment(AppState.self) private var state
    let task: TaskItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("#\(task.id) ").foregroundStyle(.secondary) + Text(task.title)
            HStack(spacing: 8) {
                StatusChip(status: task.status)
                LevelChip(level: task.level)
                if let kind = task.kind { KindChip(kind: kind) }
                if task.childCount > 0 {
                    Text("\(task.childDone)/\(task.childCount)")
                        .accessibilityLabel("Готово \(task.childDone) из \(task.childCount) вложенных")
                }
                if task.priority == .high || task.priority == .urgent {
                    Meta(icon: "exclamationmark.circle.fill", text: task.priority.title)
                        .foregroundStyle(.red)
                }
                if let project = task.project { Text(project) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                if let name = task.assigneeName {
                    HStack(spacing: 4) {
                        Avatar(name: name, kind: state.kind(of: name))
                        Text(name)
                    }
                }
                if task.totalSeconds > 0 {
                    Meta(icon: "clock", text: Format.duration(task.totalSeconds))
                        .accessibilityLabel("Затрачено \(Format.duration(task.totalSeconds))")
                }
                if task.commentCount > 0 {
                    Meta(icon: "bubble", text: "\(task.commentCount)")
                        .accessibilityLabel("Комментариев: \(task.commentCount)")
                }
                if task.attachmentCount > 0 {
                    Meta(icon: "paperclip", text: "\(task.attachmentCount)")
                        .accessibilityLabel("Вложений: \(task.attachmentCount)")
                }
                Spacer(minLength: 0)
                Text(Format.ago(task.updatedAt)).lineLimit(1)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

/// Icon + short text that never wraps.
struct Meta: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
            Text(text)
        }
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

struct NewTaskView: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    var project = ""
    let onCreated: (Int) -> Void

    @State private var title = ""
    @State private var details = ""
    @State private var assignee = ""
    @State private var priority = TaskPriority.normal
    @State private var projectName = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            ThemedList {
                Section {
                    TextField("Название", text: $title, axis: .vertical)
                    TextField("Что нужно сделать", text: $details, axis: .vertical)
                        .lineLimit(4...12)
                }
                Section {
                    Picker("Исполнитель", selection: $assignee) {
                        Text("Не назначен").tag("")
                        ForEach(state.accounts.filter { !$0.disabled }) { Text($0.name).tag($0.name) }
                    }
                    Picker("Приоритет", selection: $priority) {
                        ForEach(TaskPriority.allCases) { Text($0.title).tag($0) }
                    }
                    TextField("Проект", text: $projectName)
                        .textInputAutocapitalization(.never)
                }
                ErrorBanner(message: error)
            }
            .navigationTitle("Новая задача")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { if projectName.isEmpty { projectName = project } }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Создать") { Task { await create() } }
                        .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func create() async {
        guard let client = state.client else { return }
        busy = true
        defer { busy = false }
        var body: [String: JSONValue] = [
            "title": .string(title),
            "description": .string(details),
            "priority": .string(priority.rawValue),
        ]
        if !assignee.isEmpty { body["assignee"] = .string(assignee) }
        let trimmed = projectName.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty { body["project"] = .string(trimmed) }
        do {
            let task: TaskItem = try await client.send("POST", "/api/tasks", body: body)
            dismiss()
            onCreated(task.id)
        } catch {
            self.error = state.message(for: error)
        }
    }
}
