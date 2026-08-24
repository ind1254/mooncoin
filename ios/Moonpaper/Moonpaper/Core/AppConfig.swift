import Foundation
import SwiftUI

enum AppConfig {
    static let apiBaseURL = URL(string: "https://mooncoin-two.vercel.app")!
    static let privacyURL = apiBaseURL.appending(path: "privacy")
    static let supportURL = apiBaseURL.appending(path: "support")
    static let websiteURL = apiBaseURL
}

enum FomoLinkBuilder {
    static let solanaChainID = "1399811149"

    static func tokenURL(mint: String) -> URL {
        var components = URLComponents(string: "https://fomo.family/coin")!
        components.queryItems = [
            URLQueryItem(name: "address", value: mint.trimmingCharacters(in: .whitespacesAndNewlines)),
            URLQueryItem(name: "chainId", value: solanaChainID),
        ]
        return components.url!
    }
}

enum MoonpaperTheme {
    static let background = Color(red: 0.025, green: 0.03, blue: 0.09)
    static let surface = Color(red: 0.07, green: 0.075, blue: 0.15)
    static let surfaceRaised = Color(red: 0.11, green: 0.105, blue: 0.21)
    static let mint = Color(red: 0.28, green: 0.95, blue: 0.78)
    static let violet = Color(red: 0.52, green: 0.32, blue: 0.98)
    static let warning = Color(red: 1.0, green: 0.68, blue: 0.25)
    static let danger = Color(red: 1.0, green: 0.36, blue: 0.48)
}

