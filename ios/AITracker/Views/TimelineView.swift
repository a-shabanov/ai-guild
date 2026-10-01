import SwiftUI

struct TimelineTask: Codable, Identifiable {
    let id: Int
    let title: String
    let level: TaskLevel
    let status: TaskStatus
    let parentId: Int?
    let startedAt: Date
    let seconds: Int
    /// "2026-09-29" → seconds worked that day, in the time zone that was asked for.
    let days: [String: Int]
}

struct TimelineResponse: Codable {
    let tz: String
    let tasks: [TimelineTask]
}

/// Tasks by day: when each one was worked on and how much.
struct ProjectTimelineView: View {
    @Environment(AppState.self) private var state
    let project: String

    /// A task with the work of everything under it.
    private struct Row: Identifiable {
        let task: TimelineTask
        let depth: Int
        let children: Int
        /// Day number → seconds.
        let days: [Int: Int]
        /// The day the task appeared, when no time was logged on it or under it.
        let marker: Int?

        var id: Int { task.id }
        var total: Int { days.values.reduce(0, +) }
    }

    private struct Pick: Equatable {
        let task: Int
        let day: Int
    }

    @State private var rows: [Row] = []
    @State private var closed: Set<Int> = []
    @State private var picked: Pick?
    @State private var scrollX: CGFloat = 0
    @State private var error: String?
    @State private var loaded = false

    private static let day: CGFloat = 22
    private static let rowHeight: CGFloat = 34
    private static let headHeight: CGFloat = 40
    private static let nameWidth: CGFloat = 156
    /// Upper bounds of the four steps of daily load, in seconds.
    private static let steps = [15 * 60, 3600, 3 * 3600, Int.max]
    private static let stepNames = ["до 15 мин", "до 1 ч", "до 3 ч", "больше 3 ч"]

    private static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()

    private static func opacity(_ seconds: Int) -> Double {
        [0.3, 0.5, 0.75, 1][steps.firstIndex { seconds <= $0 } ?? 3]
    }

    /// "2026-09-29" → days since 1970.
    private static func number(_ day: String) -> Int? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        else { return nil }
        return Int(date.timeIntervalSince1970 / 86400)
    }

    private static func date(_ number: Int) -> Date {
        Date(timeIntervalSince1970: TimeInterval(number) * 86400)
    }

    private static func label(_ number: Int, _ format: Date.FormatStyle) -> String {
        var style = format.locale(Locale(identifier: "ru_RU"))
        style.timeZone = calendar.timeZone
        return date(number).formatted(style)
    }

    /// The day of a moment where the user is.
    private static func local(_ date: Date) -> Int {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return Int((calendar.date(from: parts) ?? date).timeIntervalSince1970 / 86400)
    }

    private var visible: [Row] {
        var hiddenBelow: Int?
        return rows.filter { row in
            if let depth = hiddenBelow {
                if row.depth > depth { return false }
                hiddenBelow = nil
            }
            if closed.contains(row.id) { hiddenBelow = row.depth }
            return true
        }
    }

    private var range: ClosedRange<Int> {
        let today = Self.local(.now)
        let all = rows.flatMap { Array($0.days.keys) + ($0.marker.map { [$0] } ?? []) }
        return ((all.min() ?? today) - 1)...(max(all.max() ?? today, today) + 1)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let error { ErrorBanner(message: error).padding() }
            if rows.isEmpty && loaded && error == nil {
                ContentUnavailableView("Задач пока нет", systemImage: "calendar")
            } else if !rows.isEmpty {
                summary
                chart
                footer
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.appSurface)
        .overlay { if !loaded { ProgressView() } }
        .navigationTitle("График")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Свернуть всё", systemImage: "arrow.down.right.and.arrow.up.left") {
                        closed = Set(rows.filter { $0.children > 0 }.map(\.id))
                    }
                    Button("Развернуть всё", systemImage: "arrow.up.left.and.arrow.down.right") { closed = [] }
                } label: {
                    Label("Вид", systemImage: "list.bullet.indent")
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private var summary: some View {
        let worked = Set(rows.flatMap { $0.task.days.keys }).count
        let total = rows.reduce(0) { $0 + $1.task.seconds }
        return HStack {
            Text(project).font(.subheadline.weight(.semibold))
            Spacer()
            Text("\(Format.duration(total)) · дней работы: \(worked)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    private var chart: some View {
        let range = range
        let count = range.count
        let width = CGFloat(count) * Self.day
        let shown = visible
        return ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                // Reports how far the chart is scrolled, so that the names can stay in place.
                GeometryReader { geo in
                    Color.clear.preference(key: ScrollOffset.self, value: -geo.frame(in: .named("timeline")).minX)
                }
                .frame(height: 0)
                HStack(spacing: 0) {
                    Text("Задач: \(rows.count)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 12)
                        .frame(width: Self.nameWidth, height: Self.headHeight, alignment: .leading)
                        .background(Color.appSurface)
                        .overlay(alignment: .trailing) { Divider() }
                        .offset(x: scrollX)
                        .zIndex(1)
                    head(range).frame(width: width, height: Self.headHeight)
                }
                Divider()
                ScrollView(.vertical) {
                    LazyVStack(spacing: 0) {
                        ForEach(shown) { row in
                            HStack(spacing: 0) {
                                name(row)
                                    .offset(x: scrollX)
                                    .zIndex(1)
                                track(row, range: range).frame(width: width, height: Self.rowHeight)
                            }
                            .frame(height: Self.rowHeight)
                            Divider()
                        }
                    }
                }
            }
            .frame(width: Self.nameWidth + width)
        }
        .coordinateSpace(name: "timeline")
        .onPreferenceChange(ScrollOffset.self) { scrollX = max(0, $0) }
        .defaultScrollAnchor(.trailing)
    }

    private func head(_ range: ClosedRange<Int>) -> some View {
        Canvas { context, size in
            let first = range.lowerBound
            for number in range {
                let x = CGFloat(number - first) * Self.day
                let parts = Self.calendar.dateComponents([.day, .weekday], from: Self.date(number))
                if parts.day == 1 || number == first {
                    let month = Self.label(number, .dateTime.month(.wide).year())
                        .replacingOccurrences(of: " г.", with: "")
                    context.draw(
                        Text(month.prefix(1).uppercased() + month.dropFirst()).font(.caption2.weight(.semibold)),
                        at: CGPoint(x: x + 4, y: 10), anchor: .leading)
                }
                let weekend = parts.weekday == 1 || parts.weekday == 7
                context.draw(
                    Text("\(parts.day ?? 0)").font(.caption2).foregroundStyle(weekend ? .tertiary : .secondary),
                    at: CGPoint(x: x + Self.day / 2, y: size.height - 11))
            }
        }
        .accessibilityHidden(true)
    }

    private func name(_ row: Row) -> some View {
        HStack(spacing: 4) {
            if row.children > 0 {
                Button {
                    if closed.contains(row.id) { closed.remove(row.id) } else { closed.insert(row.id) }
                } label: {
                    Image(systemName: closed.contains(row.id) ? "chevron.right" : "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .frame(width: 22, height: Self.rowHeight)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(closed.contains(row.id) ? "Развернуть" : "Свернуть")
            } else {
                Circle().fill(row.task.status.color).frame(width: 7, height: 7).frame(width: 22)
            }
            NavigationLink(value: row.task.id) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(row.task.title)
                        .font(.caption.weight(row.task.level == .epic ? .bold : row.children > 0 ? .semibold : .regular))
                        .lineLimit(1)
                    if row.total > 0 {
                        Text(Format.duration(row.total)).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, CGFloat(min(row.depth, 3)) * 8 + 2)
        .padding(.trailing, 4)
        .frame(width: Self.nameWidth, height: Self.rowHeight, alignment: .leading)
        .background(Color.appSurface)
        .overlay(alignment: .trailing) { Divider() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.task.level.title) \(row.task.title), \(row.task.status.title), \(Format.duration(row.total))")
    }

    private func track(_ row: Row, range: ClosedRange<Int>) -> some View {
        let first = range.lowerBound
        let today = Self.local(.now)
        return Canvas { context, size in
            for number in range {
                let weekday = Self.calendar.component(.weekday, from: Self.date(number))
                if weekday == 1 || weekday == 7 {
                    let x = CGFloat(number - first) * Self.day
                    context.fill(
                        Path(CGRect(x: x, y: 0, width: Self.day, height: size.height)),
                        with: .color(.gray.opacity(0.1)))
                }
            }
            if let from = row.days.keys.min(), let to = row.days.keys.max(), from < to {
                let line = CGRect(
                    x: CGFloat(from - first) * Self.day + Self.day / 2, y: size.height / 2 - 1,
                    width: CGFloat(to - from) * Self.day, height: 2)
                context.fill(Path(line), with: .color(.gray.opacity(0.35)))
            }
            func cell(_ number: Int) -> CGRect {
                CGRect(
                    x: CGFloat(number - first) * Self.day + 2, y: (size.height - 18) / 2,
                    width: Self.day - 4, height: 18)
            }
            for (number, seconds) in row.days {
                let shape = Path(roundedRect: cell(number), cornerRadius: 4)
                // Cover the line first, so a faint cell does not show it through.
                context.fill(shape, with: .color(Color.appSurface))
                context.fill(shape, with: .color(.accentColor.opacity(Self.opacity(seconds))))
                if picked == Pick(task: row.id, day: number) {
                    context.stroke(
                        Path(roundedRect: cell(number).insetBy(dx: -2, dy: -2), cornerRadius: 6),
                        with: .color(.primary), lineWidth: 2)
                }
            }
            if let marker = row.marker {
                context.stroke(
                    Path(roundedRect: cell(marker).insetBy(dx: 1, dy: 1), cornerRadius: 4),
                    with: .color(.secondary), lineWidth: 1.5)
            }
            let x = CGFloat(today - first) * Self.day + Self.day / 2
            context.fill(Path(CGRect(x: x, y: 0, width: 1, height: size.height)), with: .color(.red.opacity(0.7)))
        }
        .contentShape(Rectangle())
        .onTapGesture { point in
            let number = first + Int(point.x / Self.day)
            picked = row.days[number] != nil || row.marker == number ? Pick(task: row.id, day: number) : nil
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var footer: some View {
        Divider()
        Group {
            if let picked, let row = rows.first(where: { $0.id == picked.task }) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Self.label(picked.day, .dateTime.day().month(.wide).weekday(.abbreviated)))
                            .font(.footnote.weight(.semibold))
                        Text(row.task.title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Text(row.days[picked.day].map(Format.duration) ?? "время не записано")
                        .font(.footnote)
                        .monospacedDigit()
                }
            } else {
                HStack(spacing: 10) {
                    ForEach(Array(Self.stepNames.enumerated()), id: \.offset) { index, name in
                        HStack(spacing: 4) {
                            RoundedRectangle(cornerRadius: 3)
                                .fill(Color.accentColor.opacity([0.3, 0.5, 0.75, 1][index]))
                                .frame(width: 12, height: 12)
                            Text(name)
                        }
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Насыщенность клетки — сколько работали за день")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
        .background(Color.appCard)
    }

    private func load() async {
        guard let client = state.client else { return }
        do {
            let answer: TimelineResponse = try await client.get("/api/timeline", query: [
                .init(name: "project", value: project),
                .init(name: "tz", value: TimeZone.current.identifier),
            ])
            let first = rows.isEmpty
            rows = Self.rows(from: answer.tasks)
            // Large projects open as a list of their top-level items.
            if first, rows.count > 40 { closed = Set(rows.filter { $0.children > 0 }.map(\.id)) }
            error = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            self.error = state.message(for: error)
        }
        loaded = true
    }

    /// Depth-first order, with the days of the children added to their parents.
    private static func rows(from tasks: [TimelineTask]) -> [Row] {
        let known = Set(tasks.map(\.id))
        var children: [Int?: [TimelineTask]] = [:]
        for task in tasks {
            children[task.parentId.flatMap { known.contains($0) ? $0 : nil }, default: []].append(task)
        }
        var out: [Row] = []
        @discardableResult
        func walk(_ task: TimelineTask, depth: Int) -> [Int: Int] {
            var days: [Int: Int] = [:]
            for (day, seconds) in task.days {
                if let number = number(day) { days[number, default: 0] += seconds }
            }
            let at = out.count
            let kids = children[task.id] ?? []
            out.append(Row(task: task, depth: depth, children: kids.count, days: [:], marker: nil))
            for kid in kids {
                for (day, seconds) in walk(kid, depth: depth + 1) { days[day, default: 0] += seconds }
            }
            out[at] = Row(
                task: task, depth: depth, children: kids.count, days: days,
                marker: days.isEmpty ? local(task.startedAt) : nil)
            return days
        }
        for task in children[nil] ?? [] { walk(task, depth: 0) }
        return out
    }
}

private struct ScrollOffset: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        // Views that report nothing answer with the default; they must not erase the offset.
        let next = nextValue()
        if next != 0 { value = next }
    }
}
