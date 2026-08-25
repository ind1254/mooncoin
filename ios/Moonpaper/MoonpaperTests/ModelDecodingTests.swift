import XCTest
@testable import Moonpaper

final class ModelDecodingTests: XCTestCase {
    func testDecodesLiveFeedContract() throws {
        let json = #"""
        {
          "kind": "trending",
          "source": "jupiter:tokens-v2",
          "fetchedAtMs": 1787608222945,
          "computedAtMs": 1787608223045,
          "ageMilliseconds": 100,
          "ageSeconds": 0,
          "refreshAfterMs": 1000,
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
            "marketAgeSeconds": 87608223,
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
              "qualityScore": 92,
              "confidenceScore": 93,
              "momentumScore": 90,
              "riskScore": 0,
              "riskLevel": "low",
              "signal": "paper_candidate",
              "actionLabel": "Paper entry candidate",
              "autoWatchEligible": true,
              "autoPaperEligible": true,
              "trendAlignment": {
                "positiveWindows": 3,
                "measuredWindows": 3,
                "label": "3/3 windows positive"
              },
              "scoreBreakdown": [{
                "id": "market",
                "label": "Market depth",
                "score": 19,
                "maxScore": 20,
                "detail": "Deep liquidity"
              }],
              "warnings": [],
              "duplicateSymbolCount": 1,
              "eligibility": "Catalog gates passed."
            },
            "rank": 1
          }]
        }
        """#

        let response = try JSONDecoder().decode(LiveFeedResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.kind, .trending)
        XCTAssertEqual(response.tokens.first?.symbol, "BONK")
        XCTAssertEqual(response.refreshAfterMs, 1_000)
        XCTAssertEqual(response.tokens.first?.assessment.qualityScore, 92)
        XCTAssertEqual(response.tokens.first?.assessment.autoPaperEligible, true)
        XCTAssertEqual(response.tokens.first?.assessment.scoreBreakdown?.first?.label, "Market depth")
        XCTAssertEqual(response.tokens.first?.rank, 1)
        XCTAssertEqual(response.tokens.first?.stats5m.priceChangePct, "8.20")
    }
}
