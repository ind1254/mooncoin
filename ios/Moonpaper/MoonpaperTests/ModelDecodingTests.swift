import XCTest
@testable import Moonpaper

final class ModelDecodingTests: XCTestCase {
    func testDecodesLiveFeedContract() throws {
        let json = #"""
        {
          "kind": "trending",
          "source": "jupiter:tokens-v2",
          "fetchedAtMs": 1787608222945,
          "ageSeconds": 0,
          "reliability": "fresh",
          "notice": "Live catalog data is not an execution guarantee.",
          "tokens": [{
            "mint": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
            "symbol": "BONK",
            "name": "Bonk",
            "iconUrl": null,
            "verifiedByProvider": true,
            "launchpad": null,
            "firstPoolAtMs": 1700000000000,
            "updatedAgeSeconds": 2,
            "reliability": "fresh",
            "priceUsd": "0.000003171",
            "liquidityUsd": "797392.90",
            "marketCapUsd": "250000000",
            "holderCount": 1009122,
            "topHolderPct": "13.74",
            "fiveMinuteVolumeUsd": "1882465.25",
            "stats5m": {
              "priceChangePct": "8.20",
              "liquidityChangePct": "1.0",
              "volumeChangePct": "3.0",
              "buyVolumeUsd": "10",
              "sellVolumeUsd": "8",
              "buys": 12,
              "sells": 9,
              "traders": 20
            },
            "assessment": {
              "status": "active",
              "qualityScore": 72,
              "riskScore": 0,
              "riskLevel": "low",
              "warnings": [],
              "duplicateSymbolCount": 1,
              "eligibility": "Catalog gates passed."
            }
          }]
        }
        """#

        let response = try JSONDecoder().decode(LiveFeedResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.kind, .trending)
        XCTAssertEqual(response.tokens.first?.symbol, "BONK")
        XCTAssertEqual(response.tokens.first?.assessment.qualityScore, 72)
        XCTAssertEqual(response.tokens.first?.stats5m.priceChangePct, "8.20")
    }
}

