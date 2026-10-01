import SwiftUI

struct InboxView: View {
    @Environment(AppState.self) private var state
    @State private var events: [TrackerEvent] = []
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            ThemedList(plain: true) {
                ErrorBanner(message: error)
                ForEach(events.reversed()) { event in
                    NavigationLink(value: event.taskId) { row(event) }
                        .swipeActions(edge: .trailing) {
                            Button("Прочитано", systemImage: "checkmark") {
                                Task { await read(task: event.taskId) }
                            }
                            .tint(.accentColor)
                        }
                }
            }
            .listStyle(.plain)
            .overlay {
                if !loaded {
                    ProgressView()
                } else if events.isEmpty && error == nil {
                    ContentUnavailableView("Новых событий нет", systemImage: "tray", description: Text("Здесь появится всё, что агенты сделают по вашим задачам"))
                }
            }
            .navigationTitle("Входящие")
            .navigationDestination(for: Int.self) { TaskDetailView(taskId: $0) }
            .toolbar {
                if let last = events.last {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Прочитано", systemImage: "checkmark.circle") {
                            Task { await acknowledge(upTo: last.id) }
                        }
                    }
                }
            }
            .refreshable { await load() }
            .task { await load() }
            // Coming back from a task: it has been read meanwhile.
            .onAppear { Task { await load() } }
        }
    }

    private func row(_ event: TrackerEvent) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Avatar(name: event.actorName, kind: event.actorKind)
                (Text(event.actorName).fontWeight(.semibold) + Text(" \(event.summary)"))
                    .font(.subheadline)
                    .lineLimit(2)
            }
            Text("#\(event.taskId) \(event.taskTitle)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let body = event.string("body") {
                Text(body).font(.subheadline).lineLimit(3)
            }
            HStack {
                RunChips(model: event.string("model"), effort: event.string("effort"))
                Spacer()
                Text(Format.ago(event.createdAt)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        guard let client = state.client else { return }
        do {
            let inbox: Inbox = try await client.get("/api/inbox")
            events = inbox.events
            state.inboxCount = events.count
            error = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            self.error = state.message(for: error)
        }
        loaded = true
    }

    private func read(task id: Int) async {
        guard let client = state.client else { return }
        do {
            let _: OK = try await client.send("POST", "/api/inbox/read", body: ["task_id": .number(Double(id))])
            await load()
        } catch {
            self.error = state.message(for: error)
        }
    }

    private func acknowledge(upTo id: Int) async {
        guard let client = state.client else { return }
        do {
            let _: [String: Int] = try await client.send(
                "POST", "/api/inbox/ack", body: ["up_to": .number(Double(id))])
            await load()
        } catch {
            self.error = state.message(for: error)
        }
    }
}
