import SwiftUI

@main
struct MoonpaperApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                .tint(MoonpaperTheme.mint)
                .preferredColorScheme(.dark)
        }
    }
}

private struct RootView: View {
    var body: some View {
        TabView {
            DiscoverView()
                .tabItem {
                    Label("Discover", systemImage: "sparkles")
                }

            AboutView()
                .tabItem {
                    Label("About", systemImage: "info.circle")
                }
        }
    }
}

