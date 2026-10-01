import Foundation

// Mirrors the server contract (server/src/schemas.ts, /api/openapi.json).
// JSON keys are snake_case; the decoder converts them to camelCase.

struct Account: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
    let kind: String
    let system: String?
    let role: String
    let keyPrefix: String
    let disabled: Bool
    let lastSeenAt: Date?

    var isAgent: Bool { kind == "agent" }
}

enum TaskStatus: String, Codable, CaseIterable, Identifiable {
    case todo, inProgress = "in_progress", review, blocked, done, cancelled

    var id: String { rawValue }

    var title: String {
        switch self {
        case .todo: "К выполнению"
        case .inProgress: "В работе"
        case .review: "На проверке"
        case .blocked: "Заблокирована"
        case .done: "Готово"
        case .cancelled: "Отменена"
        }
    }
}

enum TaskLevel: String, Codable, CaseIterable, Identifiable {
    case epic, story, task, subtask

    var id: String { rawValue }

    var title: String {
        switch self {
        case .epic: "Эпик"
        case .story: "Стори"
        case .task: "Таск"
        case .subtask: "Подтаск"
        }
    }
}

enum TaskKind: String, Codable, CaseIterable, Identifiable {
    case visual, technical

    var id: String { rawValue }

    var title: String {
        switch self {
        case .visual: "Визуал"
        case .technical: "Техническая"
        }
    }

    var icon: String {
        switch self {
        case .visual: "paintpalette"
        case .technical: "gearshape.2"
        }
    }
}

/// Another task as seen from the one being read: a parent, a child, the other end of a link.
struct TaskRef: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let status: TaskStatus
    let level: TaskLevel
    let kind: TaskKind?
    let assigneeName: String?
}

struct TaskLink: Codable, Identifiable, Hashable {
    let id: Int
    let type: String
    let task: TaskRef

    var title: String {
        switch type {
        case "blocks": "Блокирует"
        case "blocked_by": "Заблокирована задачей"
        case "relates": "Связана с"
        case "duplicates": "Дублирует"
        case "duplicated_by": "Дублируется задачей"
        default: type
        }
    }

    /// This task waits for the other one, and the other one is not finished.
    var isWaiting: Bool {
        type == "blocked_by" && task.status != .done && task.status != .cancelled
    }
}

enum TaskPriority: String, Codable, CaseIterable, Identifiable {
    case low, normal, high, urgent

    var id: String { rawValue }

    var title: String {
        switch self {
        case .low: "Низкий"
        case .normal: "Обычный"
        case .high: "Высокий"
        case .urgent: "Срочный"
        }
    }
}

struct TaskItem: Codable, Identifiable {
    let id: Int
    let title: String
    let description: String
    let status: TaskStatus
    let priority: TaskPriority
    let project: String?
    let labels: [String]
    let level: TaskLevel
    let kind: TaskKind?
    let parentId: Int?
    let childCount: Int
    let childDone: Int
    let createdByName: String
    let recordedByName: String?
    let originalText: String?
    let assigneeName: String?
    let model: String?
    let effort: String?
    let result: String?
    let resultByName: String?
    let resultModel: String?
    let resultEffort: String?
    let resultAt: Date?
    let createdAt: Date
    let updatedAt: Date
    let totalSeconds: Int
    let commentCount: Int
    let attachmentCount: Int

    // Present only on the detail endpoint.
    let ancestors: [TaskRef]?
    let children: [TaskRef]?
    let links: [TaskLink]?
    let treeSeconds: Int?
    let comments: [Comment]?
    let timeLogs: [TimeLog]?
    let attachments: [Attachment]?
    let events: [TrackerEvent]?
}

struct Comment: Codable, Identifiable {
    let id: Int
    let taskId: Int
    let authorName: String
    let authorKind: String
    let recordedByName: String?
    let originalText: String?
    let body: String
    let model: String?
    let effort: String?
    let createdAt: Date
}

struct TimeLog: Codable, Identifiable {
    let id: Int
    let accountName: String
    let model: String?
    let effort: String?
    let seconds: Int?
    let startedAt: Date
    let note: String?
    let inputTokens: Int?
    let outputTokens: Int?
    let cacheReadTokens: Int?
    let cacheWriteTokens: Int?
    let costUsd: Double?
    /// Tells parallel entries apart: "main session", "sub-agent: tests".
    let worker: String?
}

struct Project: Codable, Identifiable, Hashable {
    struct Member: Codable, Hashable {
        let name: String
        let kind: String
    }

    let id: Int
    let name: String
    let description: String
    let color: String?
    let logoUrl: String?
    let lastActivityAt: Date?
    let tasks: Int
    let openTasks: Int
    let tasksByStatus: [String: Int]
    let totalSeconds: Int
    let costUsd: Double
    let members: [Member]
    let models: [String]

    /// The decoder turns the snake_case keys of this dictionary into camelCase too.
    func count(_ status: TaskStatus) -> Int {
        let camel = status.rawValue.split(separator: "_").enumerated()
            .map { $0.offset == 0 ? String($0.element) : $0.element.capitalized }.joined()
        return tasksByStatus[status.rawValue] ?? tasksByStatus[camel] ?? 0
    }

    /// First paragraph of the description without markdown marks.
    var teaser: String {
        let first = description.components(separatedBy: "\n\n").first ?? ""
        return first.replacingOccurrences(of: "[*`#]", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct Attachment: Codable, Identifiable, Hashable {
    let id: Int
    let commentId: Int?
    let accountName: String?
    let filename: String
    let mime: String
    let size: Int
    let kind: String
    let url: String
}

struct TrackerEvent: Codable, Identifiable {
    let id: Int
    let taskId: Int
    let taskTitle: String
    let actorName: String
    let actorKind: String
    let type: String
    let data: [String: JSONValue]
    let createdAt: Date

    // Dictionary keys also go through the decoder's snake_case conversion, hence "commentId" etc.
    func string(_ key: String) -> String? { data[key]?.string }

    var summary: String {
        func status(_ key: String) -> String {
            string(key).flatMap(TaskStatus.init(rawValue:))?.title ?? string(key) ?? "?"
        }
        switch type {
        case "task_created": return "создал(а) задачу"
        case "task_assigned":
            return string("assignee").map { "назначил(а) исполнителем \($0)" } ?? "снял(а) исполнителя"
        case "status_changed": return "сменил(а) статус: \(status("from")) → \(status("to"))"
        case "task_edited": return "изменил(а) задачу"
        case "result_submitted": return "отправил(а) результат → \(status("to"))"
        case "attachment_added": return "приложил(а) файл \(string("filename") ?? "")"
        case "link_added": return "добавил(а) связь с задачей"
        case "link_removed": return "убрал(а) связь с задачей"
        case "agent_run":
            switch string("state") {
            case "started": return "запущен по сообщению человека"
            case "failed": return "запуск не удался"
            default: return "закончил запуск"
            }
        case "comment_added": return "прокомментировал(а)"
        default: return type
        }
    }
}

struct Inbox: Codable {
    let cursor: Int
    let events: [TrackerEvent]
}

struct AnalyticsRow: Codable, Identifiable {
    let keys: [String?]
    let seconds: Int
    let entries: Int
    let tasks: Int
    let inputTokens: Int
    let outputTokens: Int
    let costUsd: Double

    var id: String { keys.map { $0 ?? "—" }.joined(separator: " · ") }
    var name: String { id }
}

struct AnalyticsTotals: Codable {
    let seconds: Int
    let entries: Int
    let tasks: Int
    let inputTokens: Int
    let outputTokens: Int
    let costUsd: Double
}

struct AnalyticsResult: Codable {
    let totals: AnalyticsTotals
    let rows: [AnalyticsRow]
    let tasksByStatus: [String: Int]
}

struct APIErrorBody: Codable {
    let error: String
}

enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Double.self) {
            self = .number(v)
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else if let v = try? c.decode([JSONValue].self) {
            self = .array(v)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }

    var string: String? {
        if case .string(let v) = self { return v }
        return nil
    }
}
