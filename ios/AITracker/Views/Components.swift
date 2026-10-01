import SwiftUI

enum Format {
    static func duration(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds) с" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes) мин" }
        let rest = minutes % 60
        return rest == 0 ? "\(minutes / 60) ч" : "\(minutes / 60) ч \(rest) мин"
    }

    static func compact(_ n: Int) -> String {
        n.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))
    }

    static func money(_ n: Double) -> String {
        n.formatted(.currency(code: "USD").locale(Locale(identifier: "en_US")))
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    static func ago(_ date: Date) -> String {
        if abs(date.timeIntervalSinceNow) < 60 { return "только что" }
        return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}

extension TaskStatus {
    var color: Color {
        switch self {
        case .todo: .gray
        case .inProgress: .accentColor
        case .review: .orange
        case .blocked: .red
        case .done: .green
        case .cancelled: .gray.opacity(0.5)
        }
    }
}

struct StatusChip: View {
    let status: TaskStatus

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(status.color).frame(width: 8, height: 8)
            Text(status.title)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(Color.appFill, in: Capsule())
    }
}

struct LevelChip: View {
    let level: TaskLevel

    var body: some View {
        Text(level.title)
            .font(.caption2.weight(level == .subtask ? .regular : .semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(background, in: Capsule())
    }

    private var background: Color {
        switch level {
        case .epic: .indigo.opacity(0.22)
        case .story: .accentColor.opacity(0.16)
        default: Color.appFill
        }
    }
}

struct KindChip: View {
    let kind: TaskKind

    var body: some View {
        Label(kind.title, systemImage: kind.icon)
            .font(.caption2)
            .labelStyle(.titleAndIcon)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Color.appFill, in: Capsule())
    }
}

/// An entry that an agent wrote down for a person.
struct RecordedNote: View {
    let recordedBy: String?
    let original: String?
    @State private var open = false

    var body: some View {
        if recordedBy != nil || original != nil {
            VStack(alignment: .leading, spacing: 4) {
                if let recordedBy {
                    Text("записал \(recordedBy)").font(.caption2).foregroundStyle(.secondary)
                }
                if let original {
                    DisclosureGroup("Исходное сообщение", isExpanded: $open) {
                        Text(original)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .font(.caption)
                    .tint(.secondary)
                }
            }
        }
    }
}

/// A line for a parent, a child or a linked task.
struct TaskRefRow: View {
    let task: TaskRef
    var caption: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let caption {
                Text(caption).font(.caption).foregroundStyle(.secondary)
            }
            (Text("#\(task.id) ").foregroundStyle(.secondary) + Text(task.title))
                .strikethrough(task.status == .done)
            HStack(spacing: 6) {
                StatusChip(status: task.status)
                LevelChip(level: task.level)
                if let kind = task.kind { KindChip(kind: kind) }
            }
        }
        .padding(.vertical, 2)
    }
}

/// People are circles, agents are rounded squares; every agent system has its own colour,
/// and two letters tell apart names that start the same (claude, codex).
struct Avatar: View {
    @Environment(AppState.self) private var state
    let name: String
    let kind: String

    private static let known: [String: Color] = [
        "claude": Color(red: 0.76, green: 0.38, blue: 0.25),
        "codex": Color(red: 0.06, green: 0.54, blue: 0.42),
    ]
    private static let spare: [Color] = [.indigo, .purple, .blue, .brown, .red, .green]

    private var color: Color {
        if kind == "human" { return .teal }
        let system = state.accounts.first { $0.name == name }?.system ?? name
        if let color = Self.known[system.lowercased()] { return color }
        let hash = name.unicodeScalars.reduce(UInt32(0)) { ($0 &* 31) &+ $1.value }
        return Self.spare[Int(hash % UInt32(Self.spare.count))]
    }

    private var imageName: String? {
        guard kind != "human" else { return nil }
        let system = (state.accounts.first { $0.name == name }?.system ?? name).lowercased()
        switch system {
        case "claude": return "ClaudeAvatar"
        case "codex": return "CodexAvatar"
        default: return nil
        }
    }

    var body: some View {
        Group {
            if let imageName {
                Image(imageName)
                    .resizable()
                    .scaledToFit()
            } else {
                Text(name.prefix(2).capitalized)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: 24, height: 24)
        .background(imageName == nil ? color : .clear, in: RoundedRectangle(cornerRadius: kind == "human" ? 12 : 7, style: .continuous))
        .accessibilityHidden(true)
    }
}

/// Model and effort of the run that produced something.
struct RunChips: View {
    let model: String?
    let effort: String?

    var body: some View {
        HStack(spacing: 4) {
            if let model { chip(model).accessibilityLabel("Модель \(model)") }
            if let effort { chip(effort).accessibilityLabel("Effort \(effort)") }
        }
    }

    private func chip(_ text: String) -> some View {
        Text(text)
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.appFill, in: Capsule())
    }
}

/// Small block-level markdown renderer: headings, lists and fenced code, with inline
/// formatting handled by AttributedString.
struct MarkdownText: View {
    let source: String
    /// Attachments of the task: pictures are shown only from among them.
    var attachments: [Attachment] = []
    var onOpen: (Attachment) -> Void = { _ in }

    private enum Block {
        case image(alt: String, ref: String)
        case heading(String)
        case item(marker: String, text: String)
        case code(String)
        case paragraph(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .image(let alt, let ref):
                    if let file = Self.resolve(ref, in: attachments) {
                        Button {
                            onOpen(file)
                        } label: {
                            RemoteImage(path: file.url, contentMode: .fit) {
                                RoundedRectangle(cornerRadius: 8)
                                    .fill(Color.appFill)
                                    .frame(height: 160)
                                    .overlay { ProgressView() }
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(alt.isEmpty ? file.filename : alt)
                    } else {
                        Text("[изображение: \(alt.isEmpty ? ref : alt)]").foregroundStyle(.secondary)
                    }
                case .heading(let text):
                    inline(text).font(.headline)
                case .item(let marker, let text):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker).foregroundStyle(.secondary).monospacedDigit()
                        inline(text)
                    }
                case .code(let text):
                    ScrollView(.horizontal) {
                        Text(text).font(.caption.monospaced()).padding(8)
                    }
                    .background(Color.appFill, in: RoundedRectangle(cornerRadius: 6))
                case .paragraph(let text):
                    inline(text)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func inline(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return Text((try? AttributedString(markdown: text, options: options)) ?? AttributedString(text))
    }

    /// By file name, "attachment:12" or the attachment URL; never anything outside the tracker.
    static func resolve(_ ref: String, in attachments: [Attachment]) -> Attachment? {
        let file: Attachment?
        if let m = ref.firstMatch(of: /^(?:attachment:|\/api\/attachments\/)(\d+)(?:\/content)?$/) {
            file = attachments.first { $0.id == Int(m.1) }
        } else {
            let name = (ref.removingPercentEncoding ?? ref).components(separatedBy: "/").last
            file = attachments.last { $0.filename == name }
        }
        guard let file, file.kind == "image", file.mime != "image/svg+xml" else { return nil }
        return file
    }

    /// Ids of the attachments that the text shows inline.
    static func inlineImages(in text: String?, attachments: [Attachment]) -> Set<Int> {
        Set((text ?? "").matches(of: /!\[[^\]\n]*\]\(([^)\s]+)\)/).compactMap {
            resolve(String($0.1), in: attachments)?.id
        })
    }

    private var blocks: [Block] {
        var out: [Block] = []
        var paragraph: [String] = []
        var code: [String]?
        func flush() {
            if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
        }
        for line in source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                if let lines = code {
                    out.append(.code(lines.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    code = []
                }
            } else if code != nil {
                code?.append(line)
            } else if let m = line.firstMatch(of: /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/) {
                flush()
                out.append(.image(alt: String(m.1), ref: String(m.2)))
            } else if let m = line.firstMatch(of: /^#{1,6}\s+(.*)$/) {
                flush()
                out.append(.heading(String(m.1)))
            } else if let m = line.firstMatch(of: /^\s*[-*]\s+(.*)$/) {
                flush()
                out.append(.item(marker: "•", text: String(m.1)))
            } else if let m = line.firstMatch(of: /^\s*(\d+)[.)]\s+(.*)$/) {
                flush()
                out.append(.item(marker: "\(m.1).", text: String(m.2)))
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flush()
            } else {
                paragraph.append(line)
            }
        }
        if let lines = code { out.append(.code(lines.joined(separator: "\n"))) }
        flush()
        return out
    }
}

struct AuthorLine: View {
    let name: String
    let kind: String
    var model: String?
    var effort: String?
    let date: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Avatar(name: name, kind: kind)
                Text(name).font(.subheadline.weight(.semibold))
                Spacer()
                Text(Format.ago(date)).font(.caption).foregroundStyle(.secondary)
            }
            if model != nil || effort != nil {
                RunChips(model: model, effort: effort)
            }
        }
    }
}

struct ErrorBanner: View {
    let message: String?

    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.red)
        }
    }
}
