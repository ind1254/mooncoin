import Foundation
import SwiftUI

/// Screen state machine for the calculator (ARB-008).
/// Handles loading, error, expiry, cancellation, and backgrounding.
@MainActor
final class ArbitrageViewModel: ObservableObject {

    enum Phase: Equatable {
        case idle
        case loadingTokens
        case ready
        case calculating
        case result(CalculationResult)
        case failed(String)
    }

    @Published var phase: Phase = .idle
    @Published var tokens: [VerifiedToken] = []
    @Published var selectedToken: VerifiedToken?
    @Published var amountText: String = "500"
    @Published var isExpired: Bool = false
    @Published var history: [PaperRecord] = []

    /// Host-app seam. Mock by default; the real FOMO adapter is a blocked
    /// external dependency (docs/FOMO_INTEGRATION_REQUIREMENTS.md).
    let integration: FomoIntegrationAdapter
    private let client: ArbitrageAPIClient
    private var calculationTask: Task<Void, Never>?
    private var expiryTask: Task<Void, Never>?

    init(integration: FomoIntegrationAdapter = MockFomoIntegrationAdapter()) {
        self.integration = integration
        self.client = ArbitrageAPIClient(
            baseURL: integration.calculationAPIBaseURL,
            authorizationProvider: { try await integration.authorizationHeader() }
        )
    }

    var parsedAmount: Double? {
        guard let value = Double(amountText.replacingOccurrences(of: ",", with: "")),
              value > 0, value <= 10_000 else { return nil }
        // Enforce max two decimal places, mirroring backend validation
        return (value * 100).rounded() / 100 == value ? value : nil
    }

    var canCalculate: Bool {
        selectedToken != nil && parsedAmount != nil && phase != .calculating
    }

    func onAppear() {
        guard tokens.isEmpty else { return }
        phase = .loadingTokens
        Task {
            do {
                let fetched = try await client.fetchTokens()
                tokens = fetched
                // Prefill with the token the user is viewing in the host app,
                // when it is on the verified allowlist; otherwise first token.
                let activeMint = integration.activeTokenMint()
                selectedToken = fetched.first(where: { $0.mint == activeMint }) ?? fetched.first
                phase = .ready
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    func calculate() {
        guard let token = selectedToken, let amount = parsedAmount else { return }
        cancelCalculation()
        isExpired = false
        phase = .calculating

        calculationTask = Task {
            do {
                let result = try await client.calculate(tokenMint: token.mint, amountUsd: amount)
                guard !Task.isCancelled else { return }
                phase = .result(result)
                scheduleExpiry(at: result.quotes.expiryDate)
            } catch is CancellationError {
                // User navigated away or re-submitted; keep quiet
            } catch {
                guard !Task.isCancelled else { return }
                phase = .failed(error.localizedDescription)
            }
        }
    }

    func cancelCalculation() {
        calculationTask?.cancel()
        calculationTask = nil
        expiryTask?.cancel()
        expiryTask = nil
    }

    func loadHistory() {
        Task {
            history = (try? await client.fetchHistory()) ?? history
        }
    }

    /// Flip the result to "expired" the moment quotes pass their expiry (FR-04).
    private func scheduleExpiry(at date: Date) {
        expiryTask?.cancel()
        expiryTask = Task {
            let interval = date.timeIntervalSinceNow
            if interval > 0 {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
            guard !Task.isCancelled else { return }
            isExpired = true
        }
    }

    /// Re-check expiry when the app returns from background.
    func onScenePhaseActive() {
        if case .result(let result) = phase, result.quotes.expiryDate <= Date() {
            isExpired = true
        }
    }
}
