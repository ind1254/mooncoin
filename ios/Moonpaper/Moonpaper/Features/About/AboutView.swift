import SwiftUI

struct AboutView: View {
    var body: some View {
        NavigationStack {
            ZStack {
                MoonpaperBackground()
                ScrollView {
                    VStack(spacing: 18) {
                        Image("AppIconPreview")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 112, height: 112)
                            .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                            .shadow(color: MoonpaperTheme.violet.opacity(0.35), radius: 20, y: 8)

                        VStack(spacing: 6) {
                            Text("Moonpaper").font(.largeTitle.bold())
                            Text("Live Solana token research")
                                .foregroundStyle(.secondary)
                        }

                        SectionCard(title: "WHAT IT DOES", icon: "moon.stars") {
                            Label("Discovers new and five-minute trending Solana tokens", systemImage: "sparkles")
                            Label("Explains market, authority, concentration, and liquidity risk", systemImage: "checkmark.shield")
                            Label("Opens the exact mint in FOMO for manual review", systemImage: "hand.tap")
                        }

                        SectionCard(title: "IMPORTANT", icon: "info.circle") {
                            Text("Moonpaper is decision support, not investment advice. Scores summarize current observations and do not predict returns. Cryptocurrency can lose all of its value.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }

                        SectionCard(title: "LINKS", icon: "link") {
                            Link("Privacy Policy", destination: AppConfig.privacyURL)
                            Link("Support", destination: AppConfig.supportURL)
                            Link("Open Moonpaper Web", destination: AppConfig.websiteURL)
                        }

                        Text("Version 1.0 · Market data provided through the Moonpaper production API")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                }
            }
            .navigationTitle("About")
        }
    }
}

