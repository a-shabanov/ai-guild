import SwiftUI

extension Color {
    /// "#2a78d6" as stored by the tracker.
    init?(hex: String?) {
        guard let hex, hex.count == 7, hex.hasPrefix("#"),
              let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xff) / 255,
            green: Double((value >> 8) & 0xff) / 255,
            blue: Double(value & 0xff) / 255)
    }
}

struct ProjectLogo: View {
    let project: Project
    let size: CGFloat

    var body: some View {
        RemoteImage(path: project.logoUrl) {
            ZStack {
                Color(hex: project.color) ?? Color(.systemGray3)
                Text(project.name.prefix(1).uppercased())
                    .font(.system(size: size * 0.44, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
        .accessibilityHidden(true)
    }
}

/// Parts of a whole: one bar split by status, with the legend carrying the names.
struct StatusBar: View {
    let project: Project

    private static let order: [TaskStatus] = [.done, .review, .inProgress, .blocked, .todo, .cancelled]

    var body: some View {
        let parts = Self.order.map { ($0, project.count($0)) }.filter { $0.1 > 0 }
        if parts.isEmpty {
            Text("Задач пока нет").font(.caption).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                GeometryReader { geo in
                    let gaps = CGFloat(parts.count - 1) * 2
                    HStack(spacing: 2) {
                        ForEach(parts, id: \.0) { status, count in
                            status.color.frame(
                                width: max(4, (geo.size.width - gaps) * CGFloat(count) / CGFloat(project.tasks)))
                        }
                    }
                }
                .frame(height: 10)
                .clipShape(Capsule())
                .accessibilityHidden(true)

                HStack(spacing: 12) {
                    ForEach(parts, id: \.0) { status, count in
                        HStack(spacing: 4) {
                            Circle().fill(status.color).frame(width: 8, height: 8)
                            Text("\(status.title) \(count)")
                        }
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            }
        }
    }
}

struct ProjectsView: View {
    @Environment(AppState.self) private var state
    @State private var projects: [Project] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(spacing: 14) {
                    ErrorBanner(message: error)
                    ForEach(projects) { project in
                        NavigationLink(value: project) { ProjectCard(project: project) }
                            .buttonStyle(.plain)
                    }
                }
                .padding()
            }
            .background(Color.appBackground)
            .overlay {
                if !loaded {
                    ProgressView()
                } else if projects.isEmpty && error == nil {
                    ContentUnavailableView("Проектов пока нет", systemImage: "square.grid.2x2", description: Text("Создайте проект в веб-версии"))
                }
            }
            .navigationTitle("Проекты")
            .navigationDestination(for: Project.self) { ProjectDetailView(project: $0) }
            .navigationDestination(for: Int.self) { TaskDetailView(taskId: $0) }
            .navigationDestination(for: ProjectScreen.self) { screen in
                switch screen {
                case .board(let name):
                    BoardView(project: name)
                        .navigationTitle("Доска · \(name)")
                        .navigationBarTitleDisplayMode(.inline)
                case .timeline(let name):
                    ProjectTimelineView(project: name)
                }
            }
            .refreshable { await load() }
            .task { await load() }
            .onChange(of: state.pending, initial: true) { _, destination in
                guard case .project(let screen) = destination else { return }
                path.append(screen)
                state.pending = nil
            }
        }
    }

    private func load() async {
        guard let client = state.client else { return }
        do {
            projects = try await client.get("/api/projects", query: [.init(name: "details", value: "1")])
            error = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            self.error = state.message(for: error)
        }
        loaded = true
    }
}

struct ProjectCard: View {
    let project: Project

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ProjectLogo(project: project, size: 52)
                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name).font(.headline)
                    Text(project.lastActivityAt.map { "Активность \(Format.ago($0))" } ?? "Ещё не начат")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            if !project.teaser.isEmpty {
                Text(project.teaser).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
            }
            StatusBar(project: project)
            if project.totalSeconds > 0 {
                HStack(spacing: 12) {
                    ForEach(project.members, id: \.self) { Avatar(name: $0.name, kind: $0.kind) }
                    Spacer()
                    Meta(icon: "clock", text: Format.duration(project.totalSeconds))
                    if project.costUsd > 0 { Text(Format.money(project.costUsd)) }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appCard)
        .overlay(alignment: .top) { (Color(hex: project.color) ?? .clear).frame(height: 3) }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct ProjectDetailView: View {
    @Environment(AppState.self) private var state
    @State var project: Project
    @State private var tasks: [TaskItem] = []
    @State private var onlyOpen = true
    @State private var error: String?
    @State private var creating = false
    @State private var created: Int?

    var body: some View {
        ThemedList {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 14) {
                        ProjectLogo(project: project, size: 72)
                        Text(project.name).font(.title2.bold())
                    }
                    if project.description.isEmpty {
                        Text("Без описания").foregroundStyle(.secondary)
                    } else {
                        MarkdownText(source: project.description).font(.subheadline)
                    }
                    if !project.models.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 4) {
                                ForEach(project.models, id: \.self) { RunChips(model: $0, effort: nil) }
                            }
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            Section {
                LabeledContent("На проверке", value: "\(project.count(.review))")
                LabeledContent("Время", value: Format.duration(project.totalSeconds))
                LabeledContent("Стоимость по прайсу API", value: Format.money(project.costUsd))
                StatusBar(project: project).padding(.vertical, 4)
            }

            Section {
                NavigationLink(value: ProjectScreen.board(project.name)) {
                    Label("Доска", systemImage: "rectangle.split.3x1")
                }
                NavigationLink(value: ProjectScreen.timeline(project.name)) {
                    Label("График", systemImage: "calendar.day.timeline.left")
                }
            }

            Section {
                ErrorBanner(message: error)
                if tasks.isEmpty && error == nil {
                    Text(onlyOpen ? "Открытых задач нет" : "Задач нет").foregroundStyle(.secondary)
                }
                ForEach(tasks) { task in
                    NavigationLink(value: task.id) { TaskRow(task: task) }
                }
            } header: {
                HStack {
                    Text("Задачи")
                    Spacer()
                    Picker("Показать", selection: $onlyOpen) {
                        Text("Открытые").tag(true)
                        Text("Все").tag(false)
                    }
                    .textCase(nil)
                }
            }
        }
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Новая задача", systemImage: "plus") { creating = true }
            }
        }
        .sheet(isPresented: $creating) {
            NewTaskView(project: project.name) { _ in Task { await load() } }
        }
        .refreshable { await load() }
        .task(id: onlyOpen) { await load() }
    }

    private func load() async {
        guard let client = state.client else { return }
        var query = [URLQueryItem(name: "project", value: project.name), .init(name: "limit", value: "500")]
        if onlyOpen { query.append(.init(name: "status", value: "open")) }
        do {
            tasks = try await client.get("/api/tasks", query: query)
            project = try await client.get("/api/projects/\(project.id)")
            error = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            self.error = state.message(for: error)
        }
    }
}
