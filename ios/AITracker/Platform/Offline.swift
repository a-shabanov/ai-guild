import CryptoKit
import Foundation
import Observation

/// Whether the last answer came from the network or from the local copy.
@MainActor
@Observable
final class Connectivity {
    static let shared = Connectivity()
    private(set) var offline = false

    func set(offline: Bool) {
        if self.offline != offline { self.offline = offline }
    }
}

extension Error {
    /// The request never reached the server (as opposed to the server refusing it).
    var isConnectivity: Bool {
        guard let error = self as? URLError else { return false }
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
             .cannotFindHost, .timedOut, .dnsLookupFailed, .dataNotAllowed,
             .internationalRoamingOff, .secureConnectionFailed:
            return true
        default:
            return false
        }
    }
}

/// Last successful GET responses, so tasks can be read without a connection.
enum ResponseCache {
    private static var directory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("api", isDirectory: true)
    }

    private static func file(for url: URL) -> URL {
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        return directory.appendingPathComponent(digest.map { String(format: "%02x", $0) }.joined())
    }

    static func write(_ data: Data, for url: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: file(for: url), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func read(_ url: URL) -> Data? {
        try? Data(contentsOf: file(for: url))
    }

    static func clear() {
        try? FileManager.default.removeItem(at: directory)
    }
}

struct PendingComment: Codable, Identifiable, Equatable {
    var id = UUID()
    let taskId: Int
    let body: String
    let reopen: Bool
    var at = Date()
}

/// Comments written without a connection. They go out by themselves once it is back.
@MainActor
@Observable
final class Outbox {
    static let shared = Outbox()
    private static let storageKey = "outbox"

    private(set) var items: [PendingComment] = []
    private var flushing = false

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.storageKey),
           let saved = try? JSONDecoder().decode([PendingComment].self, from: data) {
            items = saved
        }
    }

    private func persist() {
        UserDefaults.standard.set(try? JSONEncoder().encode(items), forKey: Self.storageKey)
    }

    func pending(for taskId: Int) -> [PendingComment] {
        items.filter { $0.taskId == taskId }
    }

    func add(taskId: Int, body: String, reopen: Bool) {
        items.append(PendingComment(taskId: taskId, body: body, reopen: reopen))
        persist()
    }

    func clear() {
        items = []
        persist()
    }

    /// Sends queued comments in order. Returns how many went through.
    @discardableResult
    func flush(with client: APIClient) async -> Int {
        guard !flushing, !items.isEmpty else { return 0 }
        flushing = true
        defer { flushing = false }
        var sent = 0
        for item in items {
            do {
                let _: Comment = try await client.send(
                    "POST", "/api/tasks/\(item.taskId)/comments", body: ["body": .string(item.body)])
                if item.reopen {
                    let _: TaskItem = try await client.send(
                        "PATCH", "/api/tasks/\(item.taskId)", body: ["status": .string("in_progress")])
                }
                sent += 1
            } catch {
                if error.isConnectivity { break }
                // The server refused it (task gone, signed out): retrying would never succeed.
            }
            items.removeAll { $0.id == item.id }
            persist()
        }
        return sent
    }
}
