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
            .navigationDestination(for: TokenRoute.self) { token in
                ResearchView(token: token)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    discoveryFilters
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.loadFeed() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh live feed")
                }
            }
            .task(id: model.refreshKey) { await model.runLiveFeed() }
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
                    Text("ACTIONABLE SOLANA SIGNALS")
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
                        Label("1-second live scoring", systemImage: "dot.radiowaves.left.and.right")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(String(format: "source %.1fs", Double(model.sourceAgeMilliseconds) / 1_000))
                            .foregroundStyle(.tertiary)
                    }
                    .font(.caption)
                }
                .padding(.horizontal)

                SignalSummary(
                    paperCandidates: model.paperCandidateCount,
                    smartWatch: model.smartWatchCount,
                    newMovers: model.newMoverCount
                )

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

    private var discoveryFilters: some View {
        Menu {
            Picker("Minimum live score", selection: $model.minQualityScore) {
                Text("Every score").tag(0)
                Text("70+ actionable").tag(70)
                Text("85+ smart watch").tag(85)
                Text("90+ strongest").tag(90)
            }
            Picker("Maximum risk", selection: $model.maxRiskScore) {
                Text("Any risk").tag(0)
                Text("Medium or less · 45").tag(45)
                Text("Cautious · 25").tag(25)
                Text("Strict · 15").tag(15)
            }
            Picker("Minimum liquidity", selection: $model.minLiquidityUsd) {
                Text("Any liquidity").tag(0)
                Text("$10k+").tag(10_000)
                Text("$50k+").tag(50_000)
                Text("$250k+").tag(250_000)
                Text("$1M+").tag(1_000_000)
            }
            Picker("Minimum market cap", selection: $model.minMarketCapUsd) {
                Text("Any market cap").tag(0)
                Text("$100k+").tag(100_000)
                Text("$1M+").tag(1_000_000)
                Text("$10M+").tag(10_000_000)
            }
            Picker("Market age", selection: $model.marketAgeFilter) {
                Text("Any age").tag(0)
                Text("New + trending · under 24h").tag(-1)
                Text("Established · 1h+").tag(60)
                Text("Proven · 1d+").tag(1_440)
                Text("Long-running · 7d+").tag(10_080)
            }
            Picker("Minimum 5m volume", selection: $model.minVolume5mUsd) {
                Text("Any activity").tag(0)
                Text("$5k+").tag(5_000)
                Text("$25k+").tag(25_000)
                Text("$100k+").tag(100_000)
            }
        } label: {
            Label("Filters", systemImage: "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel("Live feed filters")
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

private struct SignalSummary: View {
    let paperCandidates: Int
    let smartWatch: Int
    let newMovers: Int

    var body: some View {
        HStack(spacing: 8) {
            signal(value: paperCandidates, label: "PAPER QUEUE", color: MoonpaperTheme.violet)
            signal(value: smartWatch, label: "SMART WATCH", color: MoonpaperTheme.mint)
            signal(value: newMovers, label: "NEW + MOVING", color: MoonpaperTheme.warning)
        }
        .padding(.horizontal)
    }

    private func signal(value: Int, label: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(value.formatted())
                .font(.title3.bold().monospacedDigit())
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 9)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(color.opacity(0.2)) }
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
                        if let rank = token.rank {
                            Text("#\(rank)")
                                .font(.caption2.bold().monospacedDigit())
                                .foregroundStyle(.tertiary)
                        }
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
                    Text(Formatters.marketAge(token.marketAgeSeconds))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                ScoreBadge(score: token.assessment.qualityScore)
            }

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 10) {
                Metric(label: "PRICE", value: Formatters.price(token.priceUsd))
                Metric(label: "5M MOVE", value: Formatters.percent(token.stats5m.priceChangePct), color: Formatters.changeColor(token.stats5m.priceChangePct))
                Metric(label: "LIQUIDITY", value: Formatters.compactUSD(token.liquidityUsd))
                Metric(label: "MARKET CAP", value: Formatters.compactUSD(token.marketCapUsd))
                Metric(label: "5M VOLUME", value: Formatters.compactUSD(token.fiveMinuteVolumeUsd))
                Metric(label: "EVIDENCE", value: "\(token.assessment.confidenceScore ?? 0)/100")
            }

            Label(
                token.assessment.actionLabel ?? "Research first",
                systemImage: token.assessment.autoPaperEligible == true ? "briefcase.fill" : token.assessment.autoWatchEligible == true ? "star.fill" : "waveform.path.ecg"
            )
            .font(.caption.weight(.semibold))
            .foregroundStyle(token.assessment.autoWatchEligible == true ? MoonpaperTheme.mint : .secondary)

            if let breakdown = token.assessment.scoreBreakdown, !breakdown.isEmpty {
                DisclosureGroup("Why this score") {
                    VStack(spacing: 7) {
                        ForEach(breakdown) { part in
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(part.label).font(.caption.weight(.semibold))
                                    Text(part.detail).font(.caption2).foregroundStyle(.tertiary)
                                }
                                Spacer()
                                Text("\(part.score)/\(part.maxScore)")
                                    .font(.caption.bold().monospacedDigit())
                            }
                        }
                    }
                    .padding(.top, 6)
                }
                .font(.caption)
                .tint(MoonpaperTheme.violet)
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
