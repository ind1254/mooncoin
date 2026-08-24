import Foundation

enum FeedKind: String, CaseIterable, Codable, Identifiable {
    case recent
    case trending

    var id: String { rawValue }
    var label: String { self == .recent ? "New" : "Trending 5m" }
}

struct TokenRoute: Hashable, Identifiable {
    let mint: String
    let symbol: String
    let name: String
    let iconURL: URL?

    var id: String { mint }
}

struct LiveFeedResponse: Decodable {
    let kind: FeedKind
    let source: String
    let fetchedAtMs: Int64
    let ageSeconds: Int
    let reliability: String
    let notice: String
    let tokens: [FeedToken]
}

struct FeedToken: Decodable, Identifiable, Hashable {
    let mint: String
    let symbol: String
    let name: String
    let iconUrl: URL?
    let verifiedByProvider: Bool
    let launchpad: String?
    let firstPoolAtMs: Int64?
    let updatedAgeSeconds: Int?
    let reliability: String
    let priceUsd: String?
    let liquidityUsd: String?
    let marketCapUsd: String?
    let holderCount: Int?
    let topHolderPct: String?
    let fiveMinuteVolumeUsd: String?
    let stats5m: FeedWindowStats
    let assessment: FeedAssessment

    var id: String { mint }
    var route: TokenRoute { TokenRoute(mint: mint, symbol: symbol, name: name, iconURL: iconUrl) }
}

struct FeedWindowStats: Decodable, Hashable {
    let priceChangePct: String?
    let liquidityChangePct: String?
    let volumeChangePct: String?
    let buyVolumeUsd: String?
    let sellVolumeUsd: String?
    let buys: Int?
    let sells: Int?
    let traders: Int?
}

struct FeedAssessment: Decodable, Hashable {
    let status: String
    let qualityScore: Int
    let riskScore: Int
    let riskLevel: String
    let warnings: [String]
    let duplicateSymbolCount: Int
    let eligibility: String
}

struct SearchResponse: Decodable {
    let query: String
    let duplicateSymbols: Bool
    let results: [SearchToken]
}

struct SearchToken: Decodable, Identifiable, Hashable {
    let mint: String
    let symbol: String
    let name: String
    let iconUrl: URL?
    let verifiedByProvider: Bool
    let priceUsd: String?
    let liquidityUsd: String?
    let holderCount: Int?

    var id: String { mint }
    var route: TokenRoute { TokenRoute(mint: mint, symbol: symbol, name: name, iconURL: iconUrl) }
}

struct ResearchProfile: Decodable {
    let mint: String
    let symbol: String
    let name: String
    let iconUrl: URL?
    let verifiedByProvider: Bool
    let marketUpdatedAtMs: Int64?
    let fetchedAtMs: Int64
    let market: ResearchMarket
    let verification: ResearchVerification
    let authorities: ResearchAuthorities
    let risk: ResearchRisk
}

struct ResearchMarket: Decodable {
    let priceUsd: String?
    let liquidityUsd: String?
    let marketCapUsd: String?
    let fdvUsd: String?
    let holderCount: Int?
    let change1hPct: String?
    let change24hPct: String?
    let buyVolume24hUsd: String?
    let sellVolume24hUsd: String?
    let numBuys24h: Int?
    let numSells24h: Int?
    let topHolderPct: String?
    let organicScore: Double?
    let organicScoreLabel: String?
    let source: String
}

struct ResearchVerification: Decodable {
    let source: String
    let checkedAtMs: Int64
    let status: String
    let detail: String?
}

struct ResearchAuthorities: Decodable {
    let mintAuthorityRevoked: Bool?
    let freezeAuthorityRevoked: Bool?
    let source: String
    let providerAgreement: String
}

struct ResearchRisk: Decodable {
    let score: Int
    let level: String
    let factors: [RiskFactor]
    let method: String
}

struct RiskFactor: Decodable, Identifiable {
    let id: String
    let label: String
    let fact: String
    let interpretation: String
    let direction: String
    let status: String
    let source: String
    let points: Int
}

struct APIErrorEnvelope: Decodable {
    let error: String?
    let message: String?
}

