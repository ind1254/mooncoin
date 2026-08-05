import SwiftUI

/// Paper-calculation history (FR-07). Read-only list of stored estimates.
struct PaperHistoryView: View {
    let records: [PaperRecord]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if records.isEmpty {
                    ContentUnavailableView(
                        "No paper calculations yet",
                        systemImage: "doc.text.magnifyingglass",
                        description: Text("Run a calculation and it will be recorded here.")
                    )
                } else {
                    List(records) { record in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(record.tokenSymbol)
                                    .font(.headline)
                                Text("\(record.buyVenueId.capitalized) → \(record.sellVenueId.capitalized)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(record.createdDate, style: .relative)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("$\(record.netProfitUsd)")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(record.isProfitable ? .green : .red)
                                    .monospacedDigit()
                                Text("on $\(record.startingAmountUsd)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Paper History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
