import Foundation

/// Typed client for the FOMO arbitrage calculation API (ARB-007).
/// Supports cancellation via structured concurrency and one retry on
/// transient transport failures. Never signs or submits anything.
struct ArbitrageAPIClient {

    enum ClientError: LocalizedError {
        case server(code: String, message: String)
        case transport
        case decoding

        var errorDescription: String? {
            switch self {
            case .server(_, let message): return message
            case .transport: return "Could not reach the calculation service."
            case .decoding: return "Unexpected response from the calculation service."
            }
        }
    }

    var baseURL: URL
    var session: URLSession = .shared
    /// Supplies the Authorization header value; nil means unauthenticated (mock mode).
    var authorizationProvider: (() async throws -> String?)?

    init(
        baseURL: URL = URL(string: "http://localhost:8787")!,
        authorizationProvider: (() async throws -> String?)? = nil
    ) {
        self.baseURL = baseURL
        self.authorizationProvider = authorizationProvider
    }

    func fetchTokens() async throws -> [VerifiedToken] {
        let response: TokenListResponse = try await get("v1/arbitrage/tokens")
        return response.tokens
    }

    func fetchHistory() async throws -> [PaperRecord] {
        let response: HistoryResponse = try await get("v1/arbitrage/history")
        return response.records
    }

    func calculate(tokenMint: String, amountUsd: Double) async throws -> CalculationResult {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/arbitrage/calculate"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        let body: [String: Any] = [
            "tokenMint": tokenMint,
            "startingAmountUsd": amountUsd,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    // MARK: - Internals

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.timeoutInterval = 15
        return try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest, isRetry: Bool = false) async throws -> T {
        var request = request
        if let provider = authorizationProvider, let header = try await provider() {
            request.setValue(header, forHTTPHeaderField: "Authorization")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            // One retry for transient transport failures only
            if !isRetry {
                try Task.checkCancellation()
                return try await send(request, isRetry: true)
            }
            throw ClientError.transport
        }

        guard let http = response as? HTTPURLResponse else { throw ClientError.transport }
        guard (200..<300).contains(http.statusCode) else {
            if let apiError = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
                throw ClientError.server(code: apiError.error, message: apiError.message)
            }
            throw ClientError.server(code: "HTTP_\(http.statusCode)", message: "Service error (\(http.statusCode)).")
        }
        guard let decoded = try? JSONDecoder().decode(T.self, from: data) else {
            throw ClientError.decoding
        }
        return decoded
    }
}
