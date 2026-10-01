import Foundation

enum APIError: LocalizedError {
    case badURL
    case unauthorized
    case offline
    case server(String)

    var errorDescription: String? {
        switch self {
        case .badURL: "Некорректный адрес сервера"
        case .unauthorized: "Неверный ключ"
        case .offline: "Нет соединения с сервером"
        case .server(let message): message
        }
    }
}

struct UploadFile {
    let filename: String
    let mime: String
    let data: Data
}

struct APIClient: Sendable {
    let baseURL: URL
    /// Session token or API key; empty for the calls made before signing in.
    let key: String

    var authHeaders: [String: String] { ["Authorization": "Bearer \(key)"] }

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = f.date(from: raw) { return date }
            f.formatOptions = [.withInternetDateTime]
            if let date = f.date(from: raw) { return date }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "bad date \(raw)"))
        }
        return d
    }()

    func url(_ path: String, query: [URLQueryItem] = []) throws -> URL {
        guard var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.badURL
        }
        parts.path = path
        if !query.isEmpty { parts.queryItems = query }
        guard let url = parts.url else { throw APIError.badURL }
        return url
    }

    private func request(_ method: String, _ path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        var req = URLRequest(url: try url(path, query: query))
        req.httpMethod = method
        if !key.isEmpty { req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        return req
    }

    private func perform(_ req: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(status) else {
            let message = (try? Self.decoder.decode(APIErrorBody.self, from: data))?.error
            throw APIError.server(message ?? "Ошибка сервера (\(status))")
        }
        return data
    }

    /// Reads fall back to the last saved answer when the server cannot be reached.
    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let req = try request("GET", path, query: query)
        do {
            let data = try await perform(req)
            let value = try Self.decoder.decode(T.self, from: data)
            if let url = req.url { ResponseCache.write(data, for: url) }
            await Connectivity.shared.set(offline: false)
            return value
        } catch where error.isConnectivity {
            guard let url = req.url, let cached = ResponseCache.read(url),
                  let value = try? Self.decoder.decode(T.self, from: cached) else {
                throw APIError.offline
            }
            await Connectivity.shared.set(offline: true)
            return value
        }
    }

    @discardableResult
    func send<T: Decodable>(_ method: String, _ path: String, body: [String: JSONValue] = [:]) async throws -> T {
        var req = try request(method, path)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let data = try await perform(req)
        await Connectivity.shared.set(offline: false)
        return try Self.decoder.decode(T.self, from: data)
    }

    func data(_ path: String) async throws -> Data {
        try await perform(request("GET", path))
    }

    func upload(taskId: Int, commentId: Int?, files: [UploadFile]) async throws {
        let boundary = "ait-\(UUID().uuidString)"
        let query = commentId.map { [URLQueryItem(name: "comment_id", value: String($0))] } ?? []
        var req = try request("POST", "/api/tasks/\(taskId)/attachments", query: query)
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        for file in files {
            let name = file.filename.replacingOccurrences(of: "\"", with: "_")
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n".utf8))
            body.append(Data("Content-Type: \(file.mime)\r\n\r\n".utf8))
            body.append(file.data)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        req.httpBody = body
        _ = try await perform(req)
    }
}

struct OK: Codable {
    let ok: Bool
}

struct SessionResponse: Codable {
    let sessionToken: String
}

struct ServerConfig: Codable {
    let apns: Bool
    let version: String?
    let build: Int?
    let providers: SignInProviders?
}
