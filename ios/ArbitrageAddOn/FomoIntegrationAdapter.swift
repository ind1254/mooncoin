import Foundation

// MARK: - FOMO host-app integration seam
//
// Direct FOMO integration is a BLOCKED EXTERNAL DEPENDENCY: it requires
// official access from FOMO Labs (see docs/FOMO_INTEGRATION_REQUIREMENTS.md).
// Everything the add-on needs from the host app flows through this protocol,
// so the calculation engine, quote validation, staleness rules, fee
// estimation, and paper history never depend on FOMO directly.
//
// NOTE: repositories under the `usefomo` GitHub organization belong to an
// unrelated marketing platform. Do NOT use them for this integration.

/// Where the integration currently stands.
enum FomoIntegrationStatus: String {
    /// Development/testing against the local mock backend. Fully functional.
    case mock
    /// Real integration cannot be built yet — waiting on FOMO Labs access.
    case awaitingOfficialAccess
    /// Reserved for the future officially-supported integration.
    case live
}

struct FomoUserContext: Hashable {
    /// Opaque account identifier supplied by the host app (never a wallet key).
    let accountId: String
    let displayName: String?
}

enum FomoIntegrationError: LocalizedError {
    case notYetAvailable

    var errorDescription: String? {
        switch self {
        case .notYetAvailable:
            return "FOMO integration is not available yet. Official access from FOMO Labs is required — see docs/FOMO_INTEGRATION_REQUIREMENTS.md."
        }
    }
}

/// Everything the arbitrage add-on may ask of the host FOMO app.
/// Deliberately excludes wallets, signing, and transaction building —
/// the add-on is calculation-only and must stay that way (FR-08).
protocol FomoIntegrationAdapter {
    var status: FomoIntegrationStatus { get }

    /// Base URL of the arbitrage calculation API this build should use.
    var calculationAPIBaseURL: URL { get }

    /// Value for the `Authorization` header, or nil for unauthenticated dev use.
    func authorizationHeader() async throws -> String?

    /// The signed-in user, for attributing paper history. Anonymous in mock mode.
    func currentUserContext() async throws -> FomoUserContext

    /// Mint address of the token the user is currently viewing in the host app,
    /// used to prefill the calculator's token picker. nil when unknown.
    func activeTokenMint() -> String?

    /// Ask the host app to open one of its own screens (e.g. the token detail
    /// page for a mint). Returns false when unsupported.
    func openTokenInHostApp(mint: String) -> Bool
}

// MARK: - Mock adapter (development & testing)

/// Fully functional stand-in used until FOMO Labs access exists.
/// Points at the local mock backend (`QUOTE_MODE=mock npm run dev`).
struct MockFomoIntegrationAdapter: FomoIntegrationAdapter {
    var status: FomoIntegrationStatus { .mock }
    var calculationAPIBaseURL: URL

    /// Simulates the host app's "currently viewed token" (BONK by default).
    var simulatedActiveTokenMint: String?

    init(
        calculationAPIBaseURL: URL = URL(string: "http://localhost:8787")!,
        simulatedActiveTokenMint: String? = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
    ) {
        self.calculationAPIBaseURL = calculationAPIBaseURL
        self.simulatedActiveTokenMint = simulatedActiveTokenMint
    }

    func authorizationHeader() async throws -> String? { nil }

    func currentUserContext() async throws -> FomoUserContext {
        FomoUserContext(accountId: "mock-user", displayName: "Paper Trader")
    }

    func activeTokenMint() -> String? { simulatedActiveTokenMint }

    func openTokenInHostApp(mint: String) -> Bool { false }
}

// MARK: - Real adapter (UNIMPLEMENTED — blocked external dependency)

/// ⚠️ UNIMPLEMENTED. This is a placeholder that fails loudly.
///
/// It stays this way until FOMO Labs provides official access (private repo or
/// Xcode project, supported API/SDK, auth method, sandbox, and legal/branding
/// permission — the full checklist is in docs/FOMO_INTEGRATION_REQUIREMENTS.md).
/// Do not "work around" the missing access by scraping, reverse-engineering,
/// or pulling code from the unrelated `usefomo` GitHub organization.
struct FomoLabsIntegrationAdapter: FomoIntegrationAdapter {
    var status: FomoIntegrationStatus { .awaitingOfficialAccess }

    var calculationAPIBaseURL: URL {
        // No production endpoint exists yet; mock mode is the only runnable path.
        URL(string: "https://unconfigured.invalid")!
    }

    func authorizationHeader() async throws -> String? {
        throw FomoIntegrationError.notYetAvailable
    }

    func currentUserContext() async throws -> FomoUserContext {
        throw FomoIntegrationError.notYetAvailable
    }

    func activeTokenMint() -> String? { nil }

    func openTokenInHostApp(mint: String) -> Bool { false }
}
