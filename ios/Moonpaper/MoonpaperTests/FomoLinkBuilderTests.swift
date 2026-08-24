import XCTest
@testable import Moonpaper

final class FomoLinkBuilderTests: XCTestCase {
    func testBuildsVerifiedSolanaUniversalLink() throws {
        let mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
        let url = FomoLinkBuilder.tokenURL(mint: mint)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let query = Dictionary(uniqueKeysWithValues: try XCTUnwrap(components.queryItems).compactMap { item in
            item.value.map { (item.name, $0) }
        })

        XCTAssertEqual(components.scheme, "https")
        XCTAssertEqual(components.host, "fomo.family")
        XCTAssertEqual(components.path, "/coin")
        XCTAssertEqual(query["address"], mint)
        XCTAssertEqual(query["chainId"], "1399811149")
    }
}
