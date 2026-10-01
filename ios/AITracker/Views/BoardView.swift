import SwiftUI

/// A board or a timeline of a project, opened from the project's page.
enum ProjectScreen: Hashable {
    case board(String)
    case timeline(String)
}

extension TaskStatus {
    static let board: [TaskStatus] = [.todo, .inProgress, .review, .blocked, .done]

    /// Who moves a task out of the column.
    var hint: String {
        switch self {
        case .todo: "ещё никто не взял"
        case .inProgress: "агент работает"
        case .review: "ждут вашего решения"
        case .blocked: "нужна помощь"
        case .done: "принято"
        case .cancelled: "не нужна"
        }
    }
}

/// Columns by status. A card moves by dragging or through its menu.
struct BoardView: View {
    @Environment(AppState.self) private var state
    /// nil shows the tasks of every project.
    var project: String?

    private enum Levels: String, CaseIterable, Identifiable {
        case work = "task,subtask", plan = "epic,story", all = ""

        var id: String { rawValue }

        var title: String {
            switch self {
            case .work: "Таски и подтаски"
            case .plan: "Эпики и стори"
            case .all: "Все уровни"
            }
        }
    }

    @State private var tasks: [TaskItem] = []
    @State private var levels = Levels.work
    @State private var assignee = ""
    @State private var column: TaskStatus? = Self.start
    @State private var allDone = false
    @State private var target: TaskStatus?
    @State private var error: String?
    @State private var loaded = false

    private static let doneShown = 20

    private static var start: TaskStatus {
        #if DEBUG
        // AITRACKER_COLUMN=review opens the board on that column, for UI checks.
        if let raw = ProcessInfo.processInfo.environment["AITRACKER_COLUMN"],
           let status = TaskStatus(rawValue: raw) { return status }
        #endif
        return .inProgress
    }

    var body: some View {
        VStack(spacing: 0) {
            tabs
            ErrorBanner(message: error).padding(.horizontal)
            GeometryReader { geo in
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 10) {
                        ForEach(TaskStatus.board) { status in
                            columnView(status)
                                .frame(width: min(340, geo.size.width - 44))
                                .id(status)
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 16)
                }
                .scrollTargetBehavior(.viewAligned)
                .scrollPosition(id: $column, anchor: .leading)
            }
        }
        .background(Color.appBackground)
        .overlay { if !loaded { ProgressView() } }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { filters }
        }
        .refreshable { await load() }
        .task(id: "\(levels.rawValue)|\(assignee)") {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    private func items(_ status: TaskStatus) -> [TaskItem] {
        tasks.filter { $0.status == status }.sorted { $0.updatedAt > $1.updatedAt }
    }

    private var tabs: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(TaskStatus.board) { status in
                        Button {
                            withAnimation { column = status }
                        } label: {
                            HStack(spacing: 5) {
                                Circle().fill(status.color).frame(width: 8, height: 8)
                                Text(status.title)
                                Text("\(items(status).count)").foregroundStyle(.secondary)
                            }
                            .font(.footnote.weight(column == status ? .semibold : .regular))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                column == status ? Color.appStrongFill : .clear, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .id(status)
                        .accessibilityAddTraits(column == status ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .onChange(of: column) { _, new in
                withAnimation { proxy.scrollTo(new, anchor: .center) }
            }
        }
    }

    private func columnView(_ status: TaskStatus) -> some View {
        let all = items(status)
        let shown = status == .done && !allDone ? Array(all.prefix(Self.doneShown)) : all
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Circle().fill(status.color).frame(width: 8, height: 8)
                        Text(status.title).font(.subheadline.weight(.semibold))
                        Text("\(all.count)").font(.subheadline).foregroundStyle(.secondary)
                    }
                    Text(status.hint).font(.caption).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 4)
                .accessibilityElement(children: .combine)

                if shown.isEmpty && loaded {
                    Text("Пусто").font(.footnote).foregroundStyle(.secondary).padding(4)
                }
                ForEach(shown) { card($0) }
                if all.count > shown.count {
                    Button("Показать все \(all.count)") { allDone = true }
                        .font(.footnote)
                        .padding(4)
                }
            }
            .padding(10)
        }
        .background(
            target == status ? Color.accentColor.opacity(0.12) : Color.appCard,
            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            if target == status {
                RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.accentColor, lineWidth: 2)
            }
        }
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first.flatMap(Int.init),
                  tasks.first(where: { $0.id == id })?.status != status else { return false }
            Task { await move(id, to: status) }
            return true
        } isTargeted: { over in
            if over { target = status } else if target == status { target = nil }
        }
        .padding(.bottom, 8)
    }

    private func card(_ task: TaskItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            NavigationLink(value: task.id) {
                VStack(alignment: .leading, spacing: 8) {
                    (Text("#\(task.id) ").foregroundStyle(.secondary) + Text(task.title))
                        .font(.subheadline.weight(.medium))
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        LevelChip(level: task.level)
                        if let kind = task.kind { KindChip(kind: kind) }
                        if project == nil, let name = task.project {
                            Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    HStack(spacing: 8) {
                        if let name = task.assigneeName {
                            Avatar(name: name, kind: state.kind(of: name))
                            Text(name).lineLimit(1)
                        } else {
                            Text("не назначен")
                        }
                        Spacer(minLength: 0)
                        if task.totalSeconds > 0 { Meta(icon: "clock", text: Format.duration(task.totalSeconds)) }
                        if task.attachmentCount > 0 { Meta(icon: "paperclip", text: "\(task.attachmentCount)") }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            HStack {
                if task.status == .review {
                    Button("Принять") { Task { await move(task.id, to: .done) } }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
                Spacer()
                Menu {
                    statusPicker(task)
                } label: {
                    Label("Статус", systemImage: "arrow.left.arrow.right")
                        .font(.caption)
                        .labelStyle(.titleAndIcon)
                }
                .accessibilityLabel("Сменить статус задачи \(task.id)")
            }
        }
        .padding(12)
        .background(Color.appRaised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .draggable(String(task.id))
        .contextMenu { statusPicker(task) }
    }

    private func statusPicker(_ task: TaskItem) -> some View {
        Picker("Статус", selection: Binding(
            get: { task.status },
            set: { new in Task { await move(task.id, to: new) } }
        )) {
            ForEach(TaskStatus.allCases) { Text($0.title).tag($0) }
        }
    }

    private var filters: some View {
        Menu {
            Picker("Уровень", selection: $levels) {
                ForEach(Levels.allCases) { Text($0.title).tag($0) }
            }
            Picker("Исполнитель", selection: $assignee) {
                Text("Любой исполнитель").tag("")
                ForEach(state.accounts.filter { !$0.disabled }) { Text($0.name).tag($0.name) }
            }
        } label: {
            Label("Фильтры", systemImage: levels == .work && assignee.isEmpty
                ? "line.3.horizontal.decrease.circle"
                : "line.3.horizontal.decrease.circle.fill")
        }
    }

    private func load() async {
        guard let client = state.client else { return }
        var query = [
            URLQueryItem(name: "limit", value: "500"),
            .init(name: "status", value: TaskStatus.board.map(\.rawValue).joined(separator: ",")),
        ]
        if let project { query.append(.init(name: "project", value: project)) }
        if !levels.rawValue.isEmpty { query.append(.init(name: "level", value: levels.rawValue)) }
        if !assignee.isEmpty { query.append(.init(name: "assignee", value: assignee)) }
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

    private func move(_ id: Int, to status: TaskStatus) async {
        guard let client = state.client else { return }
        do {
            let _: TaskItem = try await client.send(
                "PATCH", "/api/tasks/\(id)", body: ["status": .string(status.rawValue)])
            error = nil
        } catch {
            self.error = state.message(for: error)
        }
        await load()
    }
}
