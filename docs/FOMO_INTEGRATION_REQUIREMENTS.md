# FOMO Labs Integration Requirements

**Status: Moonpaper API and outbound token handoff ready; in-app embedding remains an external dependency.**
Moonpaper now exposes an owner-authenticated, cursor-based paper-decision feed
documented in `FOMO_SEQUENCE_API.md`. The web app can also open a selected
Solana mint in FOMO through FOMO's verified public universal link. Direct
embedding in the FOMO app still requires FOMO Labs to provide the items below.

`FomoLabsIntegrationAdapter` (in `ios/ArbitrageAddOn/FomoIntegrationAdapter.swift`)
is intentionally **unimplemented** and fails loudly until then. All calculation,
quote validation, stale-quote detection, fee estimation, and opportunity-history
functionality is independent of FOMO and works without it.

> ⚠️ **Do not** use repositories from the `usefomo` GitHub organization. That
> organization belongs to an unrelated marketing platform, not the FOMO trading
> app. Nothing there is relevant to this integration.

## Required from FOMO Labs

### 1. Source or SDK access
- [ ] Private repository or Xcode project access to the FOMO iOS app, **or**
- [ ] An officially supported SDK/framework the add-on can be embedded through.
- Needed to ship the SwiftUI feature inside the app (the plan explicitly rules
  out modifying a third-party app without the owner's cooperation).

### 2. Supported API or SDK surface
- [ ] Documentation for whichever public/partner API or SDK the app exposes.
- [ ] Versioning and deprecation policy.

### 3. Authentication method
- [ ] How the add-on authenticates calls attributed to a FOMO user
      (OAuth, session token, signed requests, API key — whatever they support).
- [ ] Token lifetime/refresh flow. The adapter's `authorizationHeader()` is the
      single place this plugs in.

### 4. Quote endpoints
- [ ] Any FOMO-internal quote/pricing endpoints we may compare against our
      venue quotes (Jupiter/Raydium/Orca), including response schemas.
- [ ] Whether quotes are executable (amount-specific) or indicative chart prices.

### 5. Token and chain identifiers
- [ ] How FOMO identifies tokens internally (must map to immutable Solana mint
      addresses — symbols alone are unacceptable per FR-01).
- [ ] Chain/cluster identifiers (mainnet-beta vs devnet).

### 6. Wallet/account interface
- [ ] Read-only account/user context interface (opaque account ID, display name).
- [ ] Explicitly: the add-on must **never** receive private keys or seed
      phrases; confirm a key-free interface exists.

### 7. Transaction-building interface
- [ ] For a **future, separate** execution project only: what interface FOMO
      would expose for building/submitting transactions.
- [ ] Not used by this add-on — MVP is calculation-only with no signing path —
      but the boundary must be understood so the architecture stays clean.

### 8. Sandbox environment
- [ ] A staging/sandbox build of the app and any sandbox API endpoints.
- [ ] Test accounts and devnet token allowlist for QA.

### 9. Rate limits
- [ ] Request quotas and burst limits for any FOMO endpoint we call.
- [ ] Expected backoff behavior and error codes when throttled.

### 10. Deep-link support
- [x] Outbound web handoff uses FOMO's verified universal link:
      `https://fomo.family/coin?address=<mint>&chainId=1399811149`. FOMO's
      Apple and Android association files claim the `/coin` path, and its
      public web client maps that numeric chain ID to Solana. Verified
      2026-08-24.
- [ ] A supported native URL API for `openTokenInHostApp(mint:)` in the
      standalone Swift adapter. The public HTTPS universal link can be used by
      Moonpaper's web UI without claiming an embedded SDK contract.
- [ ] Any inbound deep link the add-on should register to be opened from FOMO.

### 11. Legal and branding permission
- [ ] Written permission to ship inside the FOMO app and use the FOMO name/brand
      in the feature UI.
- [ ] Any compliance requirements they impose (disclaimers, regional
      restrictions, App Store review considerations).

## What we provide in return

- The calculation backend (`backend/`) with its API contract
  (`POST /v1/arbitrage/calculate`), risk rules, and allowlist administration.
- Drop-in SwiftUI feature (`ios/ArbitrageAddOn/`) integrated via one modifier:
  `.arbitrageAddOn(integration:)`.
- The guarantee that the shipped MVP is calculation-only: no execution path,
  no custody, `executionEnabled: false` on every response.

## Until access is granted

Run everything locally:

```bash
cd backend
QUOTE_MODE=mock npm run dev
```

and use `MockFomoIntegrationAdapter` (the default everywhere), which simulates
the host-app context and points at `http://localhost:8787`.
