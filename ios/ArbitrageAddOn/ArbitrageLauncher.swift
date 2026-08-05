import SwiftUI

/// Floating bottom-right launcher for the Arbitrage Calculator.
///
/// Integration into the FOMO app is one line on any root view:
///
///     ContentView()
///         .arbitrageAddOn()
///
struct ArbitrageLauncherModifier: ViewModifier {
    /// Defaults to the mock adapter so the screen is always runnable.
    /// Swap in FomoLabsIntegrationAdapter only once FOMO Labs access exists.
    var integration: FomoIntegrationAdapter = MockFomoIntegrationAdapter()
    @State private var showCalculator = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottomTrailing) {
                Button {
                    showCalculator = true
                } label: {
                    Image(systemName: "arrow.left.arrow.right.circle.fill")
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 56, height: 56)
                        .background(Circle().fill(Color.accentColor))
                        .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
                }
                .padding(.trailing, 20)
                .padding(.bottom, 24)
                .accessibilityLabel("Open arbitrage calculator")
                .accessibilityHint("Compares token prices across venues. Shows estimates only; no trades are made.")
            }
            .sheet(isPresented: $showCalculator) {
                ArbitrageView(integration: integration)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
    }
}

extension View {
    /// Adds the FOMO Arbitrage add-on: a floating bottom-right button that
    /// opens the calculation-only arbitrage sheet.
    ///
    /// The default mock adapter keeps the screen fully runnable today;
    /// pass a different adapter once official FOMO Labs access exists.
    func arbitrageAddOn(
        integration: FomoIntegrationAdapter = MockFomoIntegrationAdapter()
    ) -> some View {
        modifier(ArbitrageLauncherModifier(integration: integration))
    }
}

#Preview {
    Color(.systemBackground)
        .ignoresSafeArea()
        .arbitrageAddOn()
}
