import Foundation

// MARK: - API contract models (mirror backend /v1/arbitrage responses)

struct VerifiedToken: Codable, Identifiable, Hashable {
    let mint: String
    let symbol: String
    let name: String
    let decimals: Int
    let enabled: Bool
    var id: String { mint }
}

struct TokenListResponse: Codable {
    let tokens: [VerifiedToken]
}

struct CostBreakdown: Codable, Hashable {
    let venueFeesUsd: String
    let networkFeesUsd: String
    let priceImpactUsd: String
    let safetyBufferUsd: String
    let totalUsd: String
}

struct QuoteTimestamps: Codable, Hashable {
    let buyRetrievedAtMs: Int
    let sellRetrievedAtMs: Int
    let expiresAtMs: Int

    var expiryDate: Date { Date(timeIntervalSince1970: Double(expiresAtMs) / 1000) }
}

struct TokenRef: Codable, Hashable {
    let mint: String
    let symbol: String
}

/// A paper calculation result. `executionEnabled` is always false in MVP —
/// the backend has no execution path (FR-08).
struct CalculationResult: Codable, Hashable {
    let correlationId: String
    let token: TokenRef
    let buyVenue: String
    let sellVenue: String
    let startingAmountUsd: String
    let estimatedFinalUsd: String
    let grossSpreadUsd: String
    let costs: CostBreakdown
    let estimatedNetProfitUsd: String
    let estimatedReturnPct: String
    let isProfitable: Bool
    let warnings: [String]
    let quotes: QuoteTimestamps
    let status: String
    let executionEnabled: Bool
}

struct APIErrorBody: Codable {
    let error: String
    let message: String
}

struct PaperRecord: Codable, Identifiable, Hashable {
    let id: String
    let createdAtMs: Int
    let tokenSymbol: String
    let buyVenueId: String
    let sellVenueId: String
    let startingAmountUsd: String
    let netProfitUsd: String
    let isProfitable: Bool

    var createdDate: Date { Date(timeIntervalSince1970: Double(createdAtMs) / 1000) }
}

struct HistoryResponse: Codable {
    let records: [PaperRecord]
}

// MARK: - User-facing warning copy (FR-06)

enum WarningCopy {
    static func text(for code: String) -> String {
        switch code {
        case "STALE_QUOTE": return "Quotes expired — refresh before relying on this estimate."
        case "HIGH_PRICE_IMPACT": return "This trade size moves the market price noticeably."
        case "LOW_LIQUIDITY": return "Not enough liquidity for this amount."
        case "PROVIDER_FAILURE": return "A price source failed — comparison may be incomplete."
        case "INCOMPLETE_DATA": return "Quote data was incomplete for this pair."
        case "SAME_VENUE": return "Both quotes came from the same venue."
        case "TOKEN_MISMATCH": return "Token identity mismatch between venues."
        case "NOT_PROFITABLE": return "No profit after estimated costs."
        default: return code
        }
    }
}
