import SwiftUI

/// The Arbitrage Calculator screen (ARB-008).
/// Presented as a sheet from the floating launcher button.
struct ArbitrageView: View {
    @StateObject private var viewModel: ArbitrageViewModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var showHistory = false

    init(integration: FomoIntegrationAdapter = MockFomoIntegrationAdapter()) {
        _viewModel = StateObject(wrappedValue: ArbitrageViewModel(integration: integration))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Arbitrage")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            viewModel.loadHistory()
                            showHistory = true
                        } label: {
                            Image(systemName: "clock.arrow.circlepath")
                        }
                        .accessibilityLabel("Paper history")
                    }
                }
                .sheet(isPresented: $showHistory) {
                    PaperHistoryView(records: viewModel.history)
                }
        }
        .onAppear { viewModel.onAppear() }
        .onDisappear { viewModel.cancelCalculation() }
        .onChange(of: scenePhase) { phase in
            if phase == .active { viewModel.onScenePhaseActive() }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.phase {
        case .idle, .loadingTokens:
            ProgressView("Loading verified tokens…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            errorState(message)
        case .ready, .calculating, .result:
            form
        }
    }

    private var form: some View {
        ScrollView {
            VStack(spacing: 16) {
                inputCard
                if case .calculating = viewModel.phase {
                    ProgressView("Comparing venues…")
                        .padding(.top, 24)
                }
                if case .result(let result) = viewModel.phase {
                    ResultCard(result: result, isExpired: viewModel.isExpired) {
                        viewModel.calculate()
                    }
                }
                disclaimer
            }
            .padding()
        }
    }

    private var inputCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Token")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            Picker("Token", selection: $viewModel.selectedToken) {
                ForEach(viewModel.tokens) { token in
                    Text("\(token.symbol) — \(token.name)").tag(Optional(token))
                }
            }
            .pickerStyle(.menu)

            Text("Starting amount (USD)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            TextField("500", text: $viewModel.amountText)
                .keyboardType(.decimalPad)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Starting amount in US dollars")

            Button {
                viewModel.calculate()
            } label: {
                Text("Calculate")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!viewModel.canCalculate)
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemBackground)))
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(message)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Try again") { viewModel.onAppear() }
                .buttonStyle(.bordered)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var disclaimer: some View {
        Text("Estimates only. No trades are executed and no funds move. Results include fees, price impact, and a safety buffer, and expire quickly as markets change.")
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.top, 8)
    }
}

// MARK: - Result card

struct ResultCard: View {
    let result: CalculationResult
    let isExpired: Bool
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(result.token.symbol)
                    .font(.headline)
                Spacer()
                if isExpired {
                    Label("Expired", systemImage: "clock.badge.exclamationmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                } else {
                    ExpiryCountdown(expiry: result.quotes.expiryDate)
                }
            }

            row("Buy venue", result.buyVenue.capitalized)
            row("Sell venue", result.sellVenue.capitalized)
            row("Starting amount", "$\(result.startingAmountUsd)")
            row("Estimated final value", "$\(result.estimatedFinalUsd)")
            row("Estimated total costs", "-$\(result.costs.totalUsd)")

            Divider()

            HStack {
                Text("Estimated net profit")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("$\(result.estimatedNetProfitUsd) (\(result.estimatedReturnPct)%)")
                    .font(.headline)
                    .foregroundStyle(isExpired ? Color.secondary : (result.isProfitable ? .green : .red))
            }

            costDetails

            if !result.warnings.isEmpty {
                warningsView
            }

            if isExpired {
                Button {
                    onRefresh()
                } label: {
                    Label("Refresh quotes", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }

            Text(result.status)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemBackground)))
        .opacity(isExpired ? 0.75 : 1)
        .accessibilityElement(children: .contain)
    }

    private var costDetails: some View {
        DisclosureGroup("Cost breakdown") {
            VStack(spacing: 6) {
                row("Venue fees", "-$\(result.costs.venueFeesUsd)")
                row("Network fees", "-$\(result.costs.networkFeesUsd)")
                row("Price impact", "-$\(result.costs.priceImpactUsd)")
                row("Safety buffer", "-$\(result.costs.safetyBufferUsd)")
            }
            .padding(.top, 4)
        }
        .font(.subheadline)
    }

    private var warningsView: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(result.warnings, id: \.self) { code in
                Label(WarningCopy.text(for: code), systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).monospacedDigit()
        }
        .font(.subheadline)
    }
}

/// Live countdown to quote expiry (FR-04).
struct ExpiryCountdown: View {
    let expiry: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = max(0, Int(expiry.timeIntervalSince(context.date)))
            Label("\(remaining)s", systemImage: "timer")
                .font(.caption.weight(.semibold))
                .foregroundStyle(remaining <= 5 ? .orange : .secondary)
                .monospacedDigit()
                .accessibilityLabel("Quote expires in \(remaining) seconds")
        }
    }
}
