import Foundation

struct MoonpaperAPI {
    enum ClientError: LocalizedError {
        case invalidResponse
        case server(status: Int, message: String)
        case decoding

        var errorDescription: String? {
            switch self {
            case .invalidResponse:
                return "Moonpaper could not reach the live service."
            case .server(_, let message):
                return message
            case .decoding:
                return "Moonpaper received an unexpected data format."
            }
        }
    }

    let baseURL: URL
    let session: URLSession

    init(baseURL: URL = AppConfig.apiBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func feed(kind: FeedKind, limit: Int = 60) async throws -> LiveFeedResponse {
        try await get(
            path: "v1/feed",
            queryItems: [
                URLQueryItem(name: "kind", value: kind.rawValue),
                URLQueryItem(name: "limit", value: String(limit)),
            ]
        )
    }

    func search(_ query: String) async throws -> SearchResponse {
        try await get(path: "v1/search", queryItems: [URLQueryItem(name: "q", value: query)])
    }

    func research(mint: String) async throws -> ResearchProfile {
        try await get(path: "v1/research/\(mint)")
    }

    private func get<T: Decodable>(path: String, queryItems: [URLQueryItem] = []) async throws -> T {
        let endpoint = path
            .split(separator: "/")
            .reduce(baseURL) { url, component in
                url.appendingPathComponent(String(component), isDirectory: false)
            }
        var components = URLComponents(
            url: endpoint,
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else { throw ClientError.invalidResponse }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Moonpaper-iOS/1.0", forHTTPHeaderField: "User-Agent")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw ClientError.invalidResponse
        }

        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? JSONDecoder().decode(APIErrorEnvelope.self, from: data)
            throw ClientError.server(
                status: http.statusCode,
                message: body?.message ?? "Moonpaper service error (\(http.statusCode))."
            )
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ClientError.decoding
        }
    }
}
