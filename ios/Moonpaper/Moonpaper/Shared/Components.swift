import SwiftUI

struct MoonpaperBackground: View {
    var body: some View {
        LinearGradient(
            colors: [MoonpaperTheme.background, MoonpaperTheme.violet.opacity(0.16), MoonpaperTheme.background],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
    }
}

struct TokenImage: View {
    let url: URL?
    let symbol: String
    let size: CGFloat

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFill()
            default:
                ZStack {
                    LinearGradient(colors: [MoonpaperTheme.violet, MoonpaperTheme.mint], startPoint: .topLeading, endPoint: .bottomTrailing)
                    Text(String(symbol.prefix(1)).uppercased())
                        .font(.system(size: size * 0.38, weight: .black))
                        .foregroundStyle(.black.opacity(0.72))
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .stroke(.white.opacity(0.12), lineWidth: 1)
        }
    }
}

struct Metric: View {
    let label: String
    let value: String
    var color: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2.weight(.bold))
                .foregroundStyle(.tertiary)
                .tracking(0.7)
            Text(value)
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }
}

struct ScoreBadge: View {
    let score: Int

    var body: some View {
        VStack(spacing: 0) {
            Text(score.formatted())
                .font(.title2.bold().monospacedDigit())
                .foregroundStyle(MoonpaperTheme.mint)
            Text("LIVE SCORE")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.tertiary)
                .tracking(0.5)
        }
        .frame(width: 58, height: 50)
        .background(MoonpaperTheme.mint.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct RiskPill: View {
    let level: String

    private var color: Color {
        switch level.lowercased() {
        case "low": return MoonpaperTheme.mint
        case "medium": return MoonpaperTheme.warning
        default: return MoonpaperTheme.danger
        }
    }

    var body: some View {
        Text(level.uppercased())
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(color.opacity(0.12), in: Capsule())
    }
}

struct StatusPill: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.caption2.bold())
            .foregroundStyle(MoonpaperTheme.mint)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(MoonpaperTheme.mint.opacity(0.12), in: Capsule())
    }
}

struct SectionCard<Content: View>: View {
    let title: String
    let icon: String
    @ViewBuilder let content: Content

    init(title: String, icon: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.icon = icon
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Label(title, systemImage: icon)
                .font(.caption.weight(.bold))
                .foregroundStyle(MoonpaperTheme.mint)
                .tracking(0.9)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(MoonpaperTheme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(.white.opacity(0.07), lineWidth: 1)
        }
        .padding(.horizontal)
    }
}

enum Formatters {
    static func shortMint(_ mint: String) -> String {
        guard mint.count > 16 else { return mint }
        return "\(mint.prefix(8))…\(mint.suffix(6))"
    }

    static func price(_ value: String?) -> String {
        guard let value, let number = Double(value) else { return "—" }
        if number == 0 { return "$0" }
        if number >= 1 { return number.formatted(.currency(code: "USD").precision(.fractionLength(2))) }
        return "$" + String(format: "%.9f", number).replacingOccurrences(of: #"0+$"#, with: "", options: .regularExpression)
    }

    static func usd(_ value: String?) -> String {
        guard let value, let number = Double(value) else { return "—" }
        return number.formatted(.currency(code: "USD").precision(.fractionLength(2)))
    }

    static func compactUSD(_ value: String?) -> String {
        guard let value, let number = Double(value) else { return "—" }
        if number >= 1_000_000 { return String(format: "$%.1fM", number / 1_000_000) }
        if number >= 1_000 { return String(format: "$%.0fk", number / 1_000) }
        return String(format: "$%.0f", number)
    }

    static func percent(_ value: String?) -> String {
        guard let value, let number = Double(value) else { return "—" }
        return String(format: "%@%.2f%%", number > 0 ? "+" : "", number)
    }

    static func marketAge(_ seconds: Int?) -> String {
        guard let seconds else { return "Age —" }
        if seconds < 60 { return "\(seconds)s old" }
        if seconds < 3_600 { return "\(seconds / 60)m old" }
        if seconds < 86_400 { return "\(seconds / 3_600)h old" }
        return "\(seconds / 86_400)d old"
    }

    static func changeColor(_ value: String?) -> Color {
        guard let value, let number = Double(value) else { return .secondary }
        return number > 0 ? MoonpaperTheme.mint : number < 0 ? MoonpaperTheme.danger : .secondary
    }

    static func authority(_ revoked: Bool?) -> String {
        guard let revoked else { return "Unavailable" }
        return revoked ? "Revoked" : "Active"
    }
}
