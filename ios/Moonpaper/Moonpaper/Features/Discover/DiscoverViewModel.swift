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
    @Published var errorMessage: String?
    @Published var searchText = ""

    private let api: MoonpaperAPI
    private var searchTask: Task<Void, Never>?

    init(api: MoonpaperAPI = MoonpaperAPI()) {
        self.api = api
    }

    var isShowingSearch: Bool { searchText.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 }

    func loadFeed() async {
        isLoading = tokens.isEmpty
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await api.feed(kind: selectedFeed)
            guard !Task.isCancelled else { return }
            tokens = response.tokens
            lastUpdated = Date(timeIntervalSince1970: Double(response.fetchedAtMs) / 1_000)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
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
