import Foundation
import Combine

@MainActor
final class DiscoverViewModel: ObservableObject {
    @Published var selectedFeed: FeedKind = .trending
    @Published private(set) var tokens: [FeedToken] = []
    @Published private(set) var searchResults: [SearchToken] = []
    @Published private(set) var duplicateSearchSymbols = false
    @Published private(set) var isLoading = false
    @Published private(set) var isSearching = false
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var sourceAgeMilliseconds = 0
    @Published var errorMessage: String?
    @Published var searchText = ""
    @Published var minQualityScore = 70
    @Published var maxRiskScore = 45
    @Published var minLiquidityUsd = 0
    @Published var minMarketCapUsd = 0
    @Published var marketAgeFilter = 0
    @Published var minVolume5mUsd = 5_000

    private let api: MoonpaperAPI
    private var searchTask: Task<Void, Never>?

    init(api: MoonpaperAPI = MoonpaperAPI()) {
        self.api = api
    }

    var isShowingSearch: Bool { searchText.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 }
    var refreshKey: String {
        "\(selectedFeed.rawValue):\(minQualityScore):\(maxRiskScore):\(minLiquidityUsd):\(minMarketCapUsd):\(marketAgeFilter):\(minVolume5mUsd)"
    }
    var smartWatchCount: Int { tokens.filter { $0.assessment.autoWatchEligible == true }.count }
    var paperCandidateCount: Int { tokens.filter { $0.assessment.autoPaperEligible == true }.count }
    var newMoverCount: Int {
        tokens.filter { ($0.marketAgeSeconds ?? .max) <= 86_400 && $0.assessment.qualityScore >= 70 }.count
    }

    func loadFeed() async {
        isLoading = tokens.isEmpty
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await api.feed(
                kind: selectedFeed,
                minQualityScore: minQualityScore == 0 ? nil : minQualityScore,
                maxRiskScore: maxRiskScore == 0 ? nil : maxRiskScore,
                minLiquidityUsd: minLiquidityUsd == 0 ? nil : minLiquidityUsd,
                minMarketCapUsd: minMarketCapUsd == 0 ? nil : minMarketCapUsd,
                minAgeMinutes: marketAgeFilter > 0 ? marketAgeFilter : nil,
                maxAgeMinutes: marketAgeFilter == -1 ? 1_440 : nil,
                minVolume5mUsd: minVolume5mUsd == 0 ? nil : minVolume5mUsd
            )
            guard !Task.isCancelled else { return }
            tokens = response.tokens
            sourceAgeMilliseconds = response.ageMilliseconds ?? response.ageSeconds * 1_000
            lastUpdated = Date(timeIntervalSince1970: Double(response.computedAtMs ?? response.fetchedAtMs) / 1_000)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func runLiveFeed() async {
        while !Task.isCancelled {
            await loadFeed()
            do {
                try await Task.sleep(for: .seconds(1))
            } catch {
                return
            }
        }
    }

    func searchTextChanged() {
        searchTask?.cancel()
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= 2 else {
            searchResults = []
            duplicateSearchSymbols = false
            isSearching = false
            return
        }

        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            isSearching = true
            defer { isSearching = false }
            do {
                let response = try await api.search(query)
                guard !Task.isCancelled, query == searchText.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
                searchResults = response.results
                duplicateSearchSymbols = response.duplicateSymbols
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = error.localizedDescription
                searchResults = []
            }
        }
    }
}
