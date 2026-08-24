import SwiftUI

@MainActor
private final class ResearchViewModel: ObservableObject {
    @Published private(set) var profile: ResearchProfile?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let token: TokenRoute
    private let api: MoonpaperAPI

    init(token: TokenRoute, api: MoonpaperAPI = MoonpaperAPI()) {
        self.token = token
        self.api = api
    }

    func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            profile = try await api.research(mint: token.mint)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct ResearchView: View {
    let token: TokenRoute
    @StateObject private var model: ResearchViewModel

    init(token: TokenRoute) {
        self.token = token
        _model = StateObject(wrappedValue: ResearchViewModel(token: token))
    }

    var body: some View {
        ZStack {
            MoonpaperBackground()
            if model.isLoading && model.profile == nil {
                ProgressView("Researching \(token.symbol)…")
            } else if let profile = model.profile {
                profileView(profile)
            } else {
                ContentUnavailableView(
                    "Research unavailable",
                    systemImage: "wifi.exclamationmark",
                    description: Text(model.errorMessage ?? "This token could not be loaded.")
                )
            }
        }
        .navigationTitle(token.symbol)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: token.mint, subject: Text("\(token.symbol) Solana mint")) {
                    Image(systemName: "square.and.arrow.up")
                }
            }
        }
    }

    private func profileView(_ profile: ResearchProfile) -> some View {
        ScrollView {
            VStack(spacing: 16) {
                header(profile)
                marketCard(profile)
                verificationCard(profile)
                riskCard(profile)
                fomoCard(profile)

                Text("Scores describe current conditions, not future returns. Market data can change before you reach FOMO.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }
            .padding(.vertical)
        }
    }

    private func header(_ profile: ResearchProfile) -> some View {
        VStack(spacing: 12) {
            TokenImage(url: profile.iconUrl, symbol: profile.symbol, size: 74)
            HStack(spacing: 8) {
                Text(profile.symbol).font(.largeTitle.bold())
                if profile.verifiedByProvider {
                    Image(systemName: "checkmark.seal.fill").foregroundStyle(MoonpaperTheme.mint)
                }
            }
            Text(profile.name).foregroundStyle(.secondary)
            Text(profile.mint)
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .padding(.horizontal)
        }
    }

    private func marketCard(_ profile: ResearchProfile) -> some View {
        SectionCard(title: "LIVE MARKET", icon: "chart.line.uptrend.xyaxis") {
            HStack {
                Metric(label: "PRICE", value: Formatters.price(profile.market.priceUsd))
                Spacer()
                Metric(
                    label: "1H",
                    value: Formatters.percent(profile.market.change1hPct),
                    color: Formatters.changeColor(profile.market.change1hPct)
                )
                Spacer()
                Metric(
                    label: "24H",
                    value: Formatters.percent(profile.market.change24hPct),
                    color: Formatters.changeColor(profile.market.change24hPct)
                )
            }
            Divider().overlay(.white.opacity(0.08))
            LabeledContent("Liquidity", value: Formatters.usd(profile.market.liquidityUsd))
            LabeledContent("Market cap", value: Formatters.usd(profile.market.marketCapUsd))
            LabeledContent("24h bought", value: Formatters.usd(profile.market.buyVolume24hUsd))
            LabeledContent("24h sold", value: Formatters.usd(profile.market.sellVolume24hUsd))
            if let holders = profile.market.holderCount {
                LabeledContent("Holders", value: holders.formatted())
            }
            Text("Source: \(profile.market.source)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func verificationCard(_ profile: ResearchProfile) -> some View {
        SectionCard(title: "CHAIN CHECK", icon: "checkmark.shield") {
            HStack {
                Text("Verification")
                Spacer()
                StatusPill(text: profile.verification.status.replacingOccurrences(of: "_", with: " "))
            }
            LabeledContent("Mint authority", value: Formatters.authority(profile.authorities.mintAuthorityRevoked))
            LabeledContent("Freeze authority", value: Formatters.authority(profile.authorities.freezeAuthorityRevoked))
            if let detail = profile.verification.detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Text("Source: \(profile.verification.source)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func riskCard(_ profile: ResearchProfile) -> some View {
        SectionCard(title: "RISK \(profile.risk.score) / 100", icon: "exclamationmark.triangle") {
            HStack {
                RiskPill(level: profile.risk.level)
                Spacer()
                Text("Lower is safer")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(profile.risk.factors) { factor in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Image(systemName: factor.direction == "positive" ? "checkmark.circle.fill" : factor.direction == "negative" ? "exclamationmark.circle.fill" : "minus.circle.fill")
                            .foregroundStyle(factor.direction == "positive" ? MoonpaperTheme.mint : factor.direction == "negative" ? MoonpaperTheme.warning : Color.secondary)
                        Text(factor.label).font(.subheadline.weight(.semibold))
                        Spacer()
                        if factor.points > 0 { Text("+\(factor.points)").font(.caption.monospacedDigit()) }
                    }
                    Text(factor.fact).font(.footnote).foregroundStyle(.secondary)
                    Text(factor.interpretation).font(.caption).foregroundStyle(.tertiary)
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func fomoCard(_ profile: ResearchProfile) -> some View {
        SectionCard(title: "MANUAL EXECUTION", icon: "hand.tap") {
            Text("Open this exact Solana mint in FOMO. Review the token, amount, fees, slippage, and final confirmation there.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            Link(destination: FomoLinkBuilder.tokenURL(mint: profile.mint)) {
                Label("Trade manually on FOMO", systemImage: "arrow.up.right.square.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(MoonpaperTheme.mint)
            .foregroundStyle(.black)

            Text("FOMO is a third-party service. Moonpaper does not connect a wallet, hold keys, or submit transactions.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}
