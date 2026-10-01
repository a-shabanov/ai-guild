import Charts
import SwiftUI

struct AnalyticsView: View {
    @Environment(AppState.self) private var state

    enum Measure: String, CaseIterable, Identifiable {
        case time = "Время", cost = "Стоимость", tokens = "Токены"
        var id: String { rawValue }
    }

    private static let groups: [(key: String, title: String)] = [
        ("model", "Модель"), ("effort", "Effort"), ("account", "Аккаунт"),
        ("system", "Система"), ("project", "Проект"), ("task", "Задача"),
    ]

    @State private var range = 30
    @State private var group = "model"
    @State private var measure = Measure.time
    @State private var grouped: AnalyticsResult?
    @State private var daily: AnalyticsResult?
    @State private var matrix: AnalyticsResult?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ThemedList {
                Section {
                    Picker("Период", selection: $range) {
                        Text("7 дней").tag(7)
                        Text("30 дней").tag(30)
                        Text("90 дней").tag(90)
                        Text("Всё").tag(0)
                    }
                    .pickerStyle(.segmented)
                    Picker("Показатель", selection: $measure) {
                        ForEach(Measure.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                .listRowSeparator(.hidden)

                ErrorBanner(message: error)

                if let grouped, let daily, let matrix {
                    Section { tiles(grouped) }
                    Section {
                        barChart(grouped.rows)
                    } header: {
                        HStack {
                            Text(measure.rawValue)
                            Spacer()
                            Picker("Группировка", selection: $group) {
                                ForEach(Self.groups, id: \.key) { Text($0.title).tag($0.key) }
                            }
                            .textCase(nil)
                        }
                    }
                    Section("\(measure.rawValue) по дням") { dayChart(daily.rows) }
                    Section("Модель × effort") {
                        if matrix.rows.isEmpty {
                            Text("Нет данных за период").foregroundStyle(.secondary)
                        }
                        ForEach(matrix.rows) { matrixRow($0) }
                    }
                } else if error == nil {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            }
            .navigationTitle("Аналитика")
            .refreshable { await load() }
            .task(id: "\(range)|\(group)") { await load() }
        }
    }

    private func value(_ row: AnalyticsRow) -> Double {
        switch measure {
        case .time: Double(row.seconds) / 3600
        case .cost: row.costUsd
        case .tokens: Double(row.inputTokens + row.outputTokens)
        }
    }

    private func label(_ row: AnalyticsRow) -> String {
        switch measure {
        case .time: Format.duration(row.seconds)
        case .cost: Format.money(row.costUsd)
        case .tokens: Format.compact(row.inputTokens + row.outputTokens)
        }
    }

    private func tiles(_ result: AnalyticsResult) -> some View {
        let t = result.totals
        // Dictionary keys pass through the decoder's snake_case conversion too.
        let done = result.tasksByStatus["done"] ?? 0
        let review = result.tasksByStatus["review"] ?? 0
        return LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 16) {
            tile("Время работы", Format.duration(t.seconds), "\(t.entries) записей")
            tile("Стоимость", Format.money(t.costUsd), t.seconds > 0 ? "\(Format.money(t.costUsd / (Double(t.seconds) / 3600))) за час" : " ")
            tile("Токены", Format.compact(t.inputTokens + t.outputTokens), "\(Format.compact(t.inputTokens)) in · \(Format.compact(t.outputTokens)) out")
            tile("Задачи", "\(done) готово", "\(review) на проверке")
        }
        .padding(.vertical, 4)
    }

    private func tile(_ title: String, _ value: String, _ hint: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title2.weight(.semibold)).minimumScaleFactor(0.6).lineLimit(1)
            Text(hint).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func barChart(_ rows: [AnalyticsRow]) -> some View {
        let top = Array(rows.sorted { value($0) > value($1) }.prefix(10))
        if top.allSatisfy({ value($0) == 0 }) {
            Text("Нет данных за период").foregroundStyle(.secondary)
        } else {
            Chart(top) { row in
                BarMark(x: .value(measure.rawValue, value(row)), y: .value("Группа", row.name), height: .fixed(16))
                    .cornerRadius(4)
                    .annotation(position: .trailing) {
                        Text(label(row)).font(.caption2).foregroundStyle(.secondary)
                    }
            }
            .chartXAxis(.hidden)
            .chartYAxis {
                AxisMarks { _ in AxisValueLabel().font(.caption) }
            }
            .chartXScale(range: .plotDimension(endPadding: 64))
            .frame(height: CGFloat(top.count) * 34 + 8)
        }
    }

    @ViewBuilder
    private func dayChart(_ rows: [AnalyticsRow]) -> some View {
        let parser: DateFormatter = {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            f.timeZone = TimeZone(identifier: "UTC")
            return f
        }()
        let points = rows.compactMap { row in
            row.keys.first.flatMap { $0 }.flatMap(parser.date(from:)).map { (date: $0, row: row) }
        }
        if points.isEmpty {
            Text("Нет данных за период").foregroundStyle(.secondary)
        } else {
            Chart(points, id: \.date) { point in
                BarMark(x: .value("День", point.date, unit: .day), y: .value(measure.rawValue, value(point.row)))
                    .cornerRadius(3)
            }
            .chartYAxis {
                AxisMarks { mark in
                    AxisGridLine()
                    AxisValueLabel {
                        if let v = mark.as(Double.self) {
                            switch measure {
                            case .time: Text("\(v.formatted(.number.precision(.fractionLength(0...1)))) ч")
                            case .cost: Text(Format.money(v))
                            case .tokens: Text(Format.compact(Int(v)))
                            }
                        }
                    }
                }
            }
            .frame(height: 180)
            .padding(.vertical, 4)
        }
    }

    private func matrixRow(_ row: AnalyticsRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            RunChips(model: row.keys.first ?? nil, effort: row.keys.last ?? nil)
            HStack {
                Text(Format.duration(row.seconds))
                Spacer()
                Text("\(Format.compact(row.inputTokens + row.outputTokens)) ток.")
                Spacer()
                Text(Format.money(row.costUsd))
            }
            .font(.subheadline)
            .monospacedDigit()
            Text("\(row.tasks) задач · \(row.seconds > 0 ? Format.money(row.costUsd / (Double(row.seconds) / 3600)) : "—") за час")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        guard let client = state.client else { return }
        let range = range
        @Sendable func query(_ groupBy: String) -> [URLQueryItem] {
            var items = [URLQueryItem(name: "group_by", value: groupBy)]
            if range > 0 {
                let from = Date.now.addingTimeInterval(-Double(range) * 86400)
                items.append(.init(name: "from", value: from.formatted(.iso8601)))
            }
            return items
        }
        do {
            async let a: AnalyticsResult = client.get("/api/analytics", query: query(group))
            async let b: AnalyticsResult = client.get("/api/analytics", query: query("day"))
            async let c: AnalyticsResult = client.get("/api/analytics", query: query("model,effort"))
            (grouped, daily, matrix) = try await (a, b, c)
            error = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            self.error = state.message(for: error)
        }
    }
}
