import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct TaskDetailView: View {
    @Environment(AppState.self) private var state
    let taskId: Int

    @State private var task: TaskItem?
    @State private var error: String?
    @State private var draft = ""
    @State private var picks: [PhotosPickerItem] = []
    @State private var reopen = false
    @State private var sending = false
    @State private var opened: ViewerRequest?
    @State private var deciding = false
    @FocusState private var writing: Bool

    #if DEBUG
    private static var openedForCheck = false
    #endif

    private enum Entry: Identifiable {
        case comment(Comment)
        case event(TrackerEvent)

        var id: String {
            switch self {
            case .comment(let c): "c\(c.id)"
            case .event(let e): "e\(e.id)"
            }
        }

        var date: Date {
            switch self {
            case .comment(let c): c.createdAt
            case .event(let e): e.createdAt
            }
        }
    }

    var body: some View {
        Group {
            if let task {
                content(task)
            } else if let error {
                ContentUnavailableView("Не удалось загрузить", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle("#\(taskId)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let task {
                ToolbarItem(placement: .topBarTrailing) { actions(task) }
            }
        }
        .fullScreenCover(item: $opened) { AttachmentViewer(request: $0) }
        .refreshable { await load() }
        .task {
            // Poll while the screen is open so agent replies show up on their own.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(8))
            }
        }
    }

    private func content(_ task: TaskItem) -> some View {
        ThemedList {
            if task.status == .review { decision(task) }
            Section {
                if let path = task.ancestors, !path.isEmpty {
                    ForEach(path) { parent in
                        NavigationLink(value: parent.id) {
                            Label("\(parent.level.title) #\(parent.id) \(parent.title)", systemImage: "arrow.turn.left.up")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text(task.title).font(.title3.weight(.semibold))
                    HStack {
                        StatusChip(status: task.status)
                        LevelChip(level: task.level)
                        if let kind = task.kind { KindChip(kind: kind) }
                        if let project = task.project {
                            Text(project).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    AuthorLine(
                        name: task.createdByName, kind: state.kind(of: task.createdByName),
                        model: task.model, effort: task.effort, date: task.createdAt)
                    if task.description.isEmpty {
                        Text("Без описания").foregroundStyle(.secondary)
                    } else {
                        MarkdownText(source: task.description, attachments: task.attachments ?? []) { open($0, in: task) }
                    }
                    RecordedNote(recordedBy: task.recordedByName, original: task.originalText)
                }
            }

            if let result = task.result {
                Section("Результат") {
                    VStack(alignment: .leading, spacing: 8) {
                        if let name = task.resultByName, let date = task.resultAt {
                            AuthorLine(
                                name: name, kind: state.kind(of: name),
                                model: task.resultModel, effort: task.resultEffort, date: date)
                        }
                        MarkdownText(source: result, attachments: task.attachments ?? []) { open($0, in: task) }
                    }
                }
            }

            if let children = task.children, !children.isEmpty {
                Section {
                    ForEach(children) { child in
                        NavigationLink(value: child.id) { TaskRefRow(task: child) }
                    }
                } header: {
                    HStack {
                        Text("Состоит из")
                        Spacer()
                        Text("готово \(task.childDone) из \(task.childCount)")
                    }
                }
            }

            if let links = task.links, !links.isEmpty {
                Section("Связи") {
                    let waiting = links.filter(\.isWaiting)
                    if !waiting.isEmpty, task.status != .done, task.status != .cancelled {
                        Label(
                            "Ждёт: " + waiting.map { "#\($0.task.id)" }.joined(separator: ", "),
                            systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                    ForEach(links) { link in
                        NavigationLink(value: link.task.id) { TaskRefRow(task: link.task, caption: link.title) }
                    }
                }
            }

            let entries = timeline(task)
            let waiting = Outbox.shared.pending(for: taskId)
            if !entries.isEmpty || !waiting.isEmpty {
                Section("Обсуждение") {
                    ForEach(entries) { entry in
                        switch entry {
                        case .comment(let c): commentRow(c, in: task)
                        case .event(let e): eventRow(e)
                        }
                    }
                    ForEach(waiting) { pendingRow($0) }
                }
            }

            Section("Комментарий") {
                TextField("Напишите агентам. Упомяните через @имя.", text: $draft, axis: .vertical)
                    .lineLimit(3...10)
                    .focused($writing)
                if !mentions.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(mentions) { account in
                                Button {
                                    mention(account.name)
                                } label: {
                                    HStack(spacing: 6) {
                                        Avatar(name: account.name, kind: account.kind)
                                        Text(account.name).font(.subheadline)
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(Color(.secondarySystemFill), in: Capsule())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Упомянуть \(account.name)")
                            }
                        }
                    }
                }
                PhotosPicker(selection: $picks, maxSelectionCount: 10, matching: .any(of: [.images, .videos])) {
                    Label(picks.isEmpty ? "Приложить фото или видео" : "Выбрано файлов: \(picks.count)", systemImage: "paperclip")
                }
                Toggle("Вернуть в работу", isOn: $reopen)
                Button {
                    Task { await send() }
                } label: {
                    HStack {
                        Text("Отправить")
                        if sending { Spacer(); ProgressView() }
                    }
                }
                .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                ErrorBanner(message: error)
            }

            Section {
                if let logs = task.timeLogs, !logs.isEmpty {
                    ForEach(logs) { timeLogRow($0) }
                } else {
                    Text("Время ещё не списывали").foregroundStyle(.secondary)
                }
            } header: {
                HStack {
                    Text("Время")
                    Spacer()
                    Text(Format.duration(task.totalSeconds))
                }
            } footer: {
                if let tree = task.treeSeconds, tree > task.totalSeconds {
                    Text("С вложенными задачами: \(Format.duration(tree))")
                }
            }

            let loose = files(of: task).filter { $0.commentId == nil }
            if !loose.isEmpty {
                Section("Вложения") { attachmentGrid(loose, among: task.attachments ?? []) }
            }
        }
        .listStyle(.insetGrouped)
    }

    /// The task waits for the person: accept the result or send it back with a comment.
    private func decision(_ task: TaskItem) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Text("Ждёт вашего решения").font(.subheadline.weight(.semibold))
                Text("\(task.resultByName ?? task.assigneeName ?? "Агент") сдал работу — посмотрите результат ниже.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                HStack {
                    Button {
                        Task { await decide("done") }
                    } label: {
                        Text("Принять").lineLimit(1).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    Button {
                        Task {
                            await decide("in_progress")
                            writing = true
                        }
                    } label: {
                        Text("Вернуть в работу").lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                .disabled(deciding)
            }
            .padding(.vertical, 4)
        }
        .listRowBackground(Color.orange.opacity(0.12))
    }

    private func decide(_ status: String) async {
        deciding = true
        defer { deciding = false }
        await patch(["status": .string(status)])
    }

    private func open(_ file: Attachment, in task: TaskItem) {
        opened = ViewerRequest(file, among: task.attachments ?? [])
    }

    /// The name being typed after "@" at the end of the comment, nil when there is none.
    private var mentionPrefix: String? {
        guard let match = draft.firstMatch(of: /(?:^|\s)@([\w.-]*)$/) else { return nil }
        return String(match.1).lowercased()
    }

    /// Accounts to offer for the name being typed.
    private var mentions: [Account] {
        guard let typed = mentionPrefix else { return [] }
        let found = state.accounts.filter {
            !$0.disabled && $0.name != state.me?.name && (typed.isEmpty || $0.name.lowercased().contains(typed))
        }
        // Nothing to offer once the name is complete.
        return found.count == 1 && found[0].name.lowercased() == typed ? [] : found
    }

    private func mention(_ name: String) {
        guard let typed = mentionPrefix else { return }
        draft = String(draft.dropLast(typed.count)) + name + " "
        writing = true
    }

    private func actions(_ task: TaskItem) -> some View {
        Menu {
            Picker("Статус", selection: Binding(
                get: { task.status },
                set: { new in Task { await patch(["status": .string(new.rawValue)]) } }
            )) {
                ForEach(TaskStatus.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.menu)
            Picker("Исполнитель", selection: Binding(
                get: { task.assigneeName ?? "" },
                set: { new in Task { await patch(["assignee": new.isEmpty ? .null : .string(new)]) } }
            )) {
                Text("Не назначен").tag("")
                ForEach(state.accounts.filter { !$0.disabled || $0.name == task.assigneeName }) {
                    Text($0.name).tag($0.name)
                }
            }
            .pickerStyle(.menu)
        } label: {
            Label("Действия", systemImage: "ellipsis.circle")
        }
    }

    private func timeline(_ task: TaskItem) -> [Entry] {
        let comments = (task.comments ?? []).map(Entry.comment)
        let events = (task.events ?? [])
            .filter { $0.type != "comment_added" && $0.type != "task_created" }
            .map(Entry.event)
        return (comments + events).sorted { $0.date < $1.date }
    }

    private func commentRow(_ c: Comment, in task: TaskItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            AuthorLine(name: c.authorName, kind: c.authorKind, model: c.model, effort: c.effort, date: c.createdAt)
            MarkdownText(source: c.body, attachments: task.attachments ?? []) { open($0, in: task) }
            RecordedNote(recordedBy: c.recordedByName, original: c.originalText)
            let files = files(of: task).filter { $0.commentId == c.id }
            if !files.isEmpty { attachmentGrid(files, among: task.attachments ?? []) }
        }
        .padding(.vertical, 2)
        .listRowBackground(c.authorKind == "human" ? Color.teal.opacity(0.08) : Color.appCard)
    }

    /// Attachments for the grids: a picture shown inside the text is not repeated there.
    private func files(of task: TaskItem) -> [Attachment] {
        let all = task.attachments ?? []
        let texts = [task.description, task.result] + (task.comments ?? []).map(\.body)
        let inline = texts.reduce(into: Set<Int>()) {
            $0.formUnion(MarkdownText.inlineImages(in: $1, attachments: all))
        }
        return all.filter { !inline.contains($0.id) }
    }

    private func pendingRow(_ c: PendingComment) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Avatar(name: state.me?.name ?? "?", kind: "human")
                Text(state.me?.name ?? "").font(.subheadline.weight(.semibold))
                Spacer()
                Label("ждёт сети", systemImage: "clock.arrow.circlepath")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            MarkdownText(source: c.body)
        }
        .padding(.vertical, 2)
        .opacity(0.6)
    }

    private func eventRow(_ e: TrackerEvent) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            (Text(e.actorName).fontWeight(.semibold) + Text(" \(e.summary)"))
                .font(.footnote)
            HStack {
                RunChips(model: e.string("model"), effort: e.string("effort"))
                Text(Format.ago(e.createdAt)).font(.caption2)
            }
        }
        .foregroundStyle(.secondary)
    }

    private func timeLogRow(_ log: TimeLog) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text([log.accountName, log.worker].compactMap { $0 }.joined(separator: " · "))
                    + Text(" · \(Format.ago(log.startedAt))").foregroundStyle(.secondary)
                RunChips(model: log.model, effort: log.effort)
                let usage = [
                    log.inputTokens.map { "\(Format.compact($0)) in" },
                    log.outputTokens.map { "\(Format.compact($0)) out" },
                    log.cacheReadTokens.map { "кэш \(Format.compact($0))" },
                    log.costUsd.map(Format.money),
                ].compactMap { $0 }
                if !usage.isEmpty {
                    Text(usage.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                }
                if let note = log.note {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let seconds = log.seconds {
                Text(Format.duration(seconds)).monospacedDigit()
            } else {
                Label("идёт", systemImage: "record.circle").foregroundStyle(.tint)
            }
        }
        .font(.subheadline)
    }

    private func attachmentGrid(_ files: [Attachment], among all: [Attachment]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 8)], spacing: 8) {
            ForEach(files) { file in
                Button {
                    opened = ViewerRequest(file, among: all)
                } label: {
                    AttachmentThumb(attachment: file)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func load() async {
        guard let client = state.client else { return }
        if !Outbox.shared.items.isEmpty { await Outbox.shared.flush(with: client) }
        do {
            let loaded: TaskItem = try await client.get("/api/tasks/\(taskId)")
            // The person is looking at the task: what happened in it is no longer news.
            if state.me?.kind == "human", loaded.events?.last?.id != task?.events?.last?.id || task == nil {
                let _: OK? = try? await client.send("POST", "/api/inbox/read", body: ["task_id": .number(Double(taskId))])
                if let inbox: Inbox = try? await client.get("/api/inbox") { state.inboxCount = inbox.events.count }
            }
            task = loaded
            if !sending { error = nil }
            #if DEBUG
            // AITRACKER_DRAFT="@c" fills the comment, for UI checks.
            if draft.isEmpty, !Self.openedForCheck, let text = ProcessInfo.processInfo.environment["AITRACKER_DRAFT"] {
                Self.openedForCheck = true
                draft = text
            }
            // AITRACKER_OPEN_ATTACHMENT=599 opens that file of the task, for UI checks.
            if !Self.openedForCheck,
               let id = ProcessInfo.processInfo.environment["AITRACKER_OPEN_ATTACHMENT"].flatMap(Int.init),
               let file = loaded.attachments?.first(where: { $0.id == id }) {
                Self.openedForCheck = true
                open(file, in: loaded)
            }
            #endif
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            if task == nil { self.error = state.message(for: error) }
        }
    }

    private func patch(_ body: [String: JSONValue]) async {
        guard let client = state.client else { return }
        do {
            task = try await client.send("PATCH", "/api/tasks/\(taskId)", body: body)
        } catch {
            self.error = state.message(for: error)
        }
    }

    private func send() async {
        guard let client = state.client else { return }
        sending = true
        defer { sending = false }
        do {
            if Connectivity.shared.offline, picks.isEmpty {
                queue()
                return
            }
            var files: [UploadFile] = []
            for (index, pick) in picks.enumerated() {
                guard let data = try await pick.loadTransferable(type: Data.self) else { continue }
                let type = pick.supportedContentTypes.first
                let ext = type?.preferredFilenameExtension ?? "bin"
                files.append(UploadFile(
                    filename: "attachment-\(index + 1).\(ext)",
                    mime: type?.preferredMIMEType ?? "application/octet-stream",
                    data: data))
            }
            let comment: Comment = try await client.send(
                "POST", "/api/tasks/\(taskId)/comments", body: ["body": .string(draft)])
            if !files.isEmpty {
                try await client.upload(taskId: taskId, commentId: comment.id, files: files)
            }
            if reopen {
                let _: TaskItem = try await client.send(
                    "PATCH", "/api/tasks/\(taskId)", body: ["status": .string("in_progress")])
            }
            draft = ""
            picks = []
            reopen = false
            error = nil
            await load()
        } catch where error.isConnectivity {
            if picks.isEmpty {
                queue()
            } else {
                self.error = "Нет сети. Файлы можно отправить только со связью."
            }
        } catch {
            self.error = state.message(for: error)
        }
    }

    /// Keeps the words: they go out by themselves once the connection is back.
    private func queue() {
        Outbox.shared.add(taskId: taskId, body: draft, reopen: reopen)
        draft = ""
        reopen = false
        error = nil
    }
}
