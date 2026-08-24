import SwiftUI

struct DiscoverView: View {
    @StateObject private var model = DiscoverViewModel()

    var body: some View {
        NavigationStack {
            ZStack {
                MoonpaperBackground()

                if model.isLoading {
                    ProgressView("Loading live Solana tokens…")
                        .tint(MoonpaperTheme.mint)
                } else {
                    content
                }
            }
            .navigationTitle("Moonpaper")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $model.searchText, prompt: "Token, name, or Solana mint")
            .onChange(of: model.searchText) { _, _ in model.searchTextChanged() }
            .onChange(of: model.selectedFeed) { _, _ in Task { await model.loadFeed() } }
            .navigationDestination(for: TokenRoute.self) { token in
                ResearchView(token: token)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.loadFeed() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh live feed")
                }
            }
            .task { await model.loadFeed() }
            .alert("Live data unavailable", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) {
                Button("Try Again") { Task { await model.loadFeed() } }
                Button("Dismiss", role: .cancel) { model.errorMessage = nil }
            } message: {
                Text(model.errorMessage ?? "Please try again.")
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.isShowingSearch {
            searchList
        } else {
            feedList
        }
    }

    private var feedList: some View {
        ScrollView {
            LazyVStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("LIVE SOLANA DISCOVERY")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(MoonpaperTheme.mint)
                        .tracking(1.2)

                    Picker("Feed", selection: $model.selectedFeed) {
                        ForEach(FeedKind.allCases) { feed in
                            Text(feed.label).tag(feed)
                        }
                    }
                    .pickerStyle(.segmented)

                    HStack {
                        Label("Live market data", systemImage: "dot.radiowaves.left.and.right")
                            .foregroundStyle(.secondary)
                        Spacer()
                        if let updated = model.lastUpdated {
                            Text(updated, style: .relative)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .font(.caption)
                }
                .padding(.horizontal)

                ForEach(model.tokens) { token in
                    NavigationLink(value: token.route) {
                        FeedTokenCard(token: token)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical)
        }
        .refreshable { await model.loadFeed() }
    }

    private var searchList: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                if model.isSearching {
                    ProgressView("Searching Solana tokens…")
                        .padding(.top, 40)
                } else if model.searchResults.isEmpty {
                    ContentUnavailableView.search(text: model.searchText)
                        .padding(.top, 28)
                } else {
                    if model.duplicateSearchSymbols {
                        Label("Some results share a ticker. Verify the mint address.", systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(MoonpaperTheme.warning)
                            .padding(.horizontal)
                    }

                    ForEach(model.searchResults) { token in
                        NavigationLink(value: token.route) {
                            SearchTokenRow(token: token)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.vertical)
        }
    }
}

private struct FeedTokenCard: View {
    let token: FeedToken

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                TokenImage(url: token.iconUrl, symbol: token.symbol, size: 48)
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(token.symbol)
                            .font(.headline)
                        RiskPill(level: token.assessment.riskLevel)
                    }
                    Text(token.name)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text(Formatters.shortMint(token.mint))
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                ScoreBadge(score: token.assessment.qualityScore)
            }

            HStack(spacing: 18) {
                Metric(label: "PRICE", value: Formatters.price(token.priceUsd))
                Metric(
                    label: "5M",
                    value: Formatters.percent(token.stats5m.priceChangePct),
                    color: Formatters.changeColor(token.stats5m.priceChangePct)
                )
                Metric(label: "LIQUIDITY", value: Formatters.compactUSD(token.liquidityUsd))
            }

            if let warning = token.assessment.warnings.first {
                Label(warning, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(MoonpaperTheme.warning)
            } else {
                Label("No immediate catalog warnings", systemImage: "checkmark.shield")
                    .font(.caption)
                    .foregroundStyle(MoonpaperTheme.mint)
            }
        }
        .padding(16)
        .background(MoonpaperTheme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(.white.opacity(0.07), lineWidth: 1)
        }
        .padding(.horizontal)
    }
}

private struct SearchTokenRow: View {
    let token: SearchToken

    var body: some View {
        HStack(spacing: 12) {
            TokenImage(url: token.iconUrl, symbol: token.symbol, size: 44)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(token.symbol).font(.headline)
                    if token.verifiedByProvider {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(MoonpaperTheme.mint)
                    }
                }
                Text(token.name).font(.subheadline).foregroundStyle(.secondary)
                Text(Formatters.shortMint(token.mint)).font(.caption.monospaced()).foregroundStyle(.tertiary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(Formatters.price(token.priceUsd)).font(.subheadline.monospacedDigit())
                Text(Formatters.compactUSD(token.liquidityUsd) + " liq")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(14)
        .background(MoonpaperTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal)
    }
}

