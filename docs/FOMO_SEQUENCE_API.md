# Moonpaper owner and FOMO sequence API

Moonpaper exposes its shadow-bot decisions as a private, cursor-based feed for
an owner-controlled native app, server, or FOMO integration adapter. The feed is
paper trading only. It never returns a transaction, wallet instruction, private
key, or real-order capability.

## Production access

Configure `OWNER_API_KEY`. Migration 009 pins the oldest existing Moonpaper
account as the owner so its Bot Lab history is preserved. The key must be at
least 32 characters and should be generated from a cryptographically secure
random source.

When the variable exists:

- password sign-up, sign-in, recovery, and verification endpoints are disabled;
- all existing `/v1/me/*` routes accept `Authorization: Bearer <owner-key>`;
- the web app shows **Owner access** instead of sign-in; and
- the key is exchanged once for an HttpOnly, Secure, SameSite session cookie.
  The browser does not store the owner key in web storage.

Do not embed the owner key in public JavaScript, a mobile repository, a URL, or
analytics. For a distributed mobile app, proxy requests through an
owner-controlled backend or replace this single-owner key with short-lived
scoped tokens before distribution.

## Direct Bot Lab API

```bash
curl https://mooncoin-two.vercel.app/v1/me/paper-bot \
  -H "Authorization: Bearer $MOONPAPER_OWNER_KEY"
```

The same header can update the bounded paper strategy with
`PUT /v1/me/paper-bot`, read the portfolio, and use other private routes. All
trading responses continue to include `simulated: true` and
`executionEnabled: false`.

## FOMO sequence feed

```http
GET /v1/integrations/fomo/sequences?limit=50&cursor=<opaque-cursor>
Authorization: Bearer <owner-key>
```

Omit `cursor` on the first request. Process each `sequenceId` once, persist
`nextCursor`, and send it on the next poll. The response is chronological. An
empty poll returns the same cursor, so consumers can safely retry. The
recommended polling interval is returned as `pollAfterMs`.

Example response:

```json
{
  "integration": "fomo",
  "schemaVersion": "2026-08-24",
  "mode": "paper",
  "simulated": true,
  "executionEnabled": false,
  "botEnabled": true,
  "strategyVersion": "shadow-v1",
  "pollAfterMs": 60000,
  "sequences": [
    {
      "sequenceId": "0c458db5-1f72-4b71-a249-9e5fb62a34ef",
      "idempotencyKey": "0c458db5-1f72-4b71-a249-9e5fb62a34ef",
      "occurredAtMs": 1787558400000,
      "chain": "solana",
      "cluster": "mainnet-beta",
      "tokenMint": "canonical-solana-mint",
      "tokenSymbol": "TOKEN",
      "action": "paper_buy",
      "decisionAction": "opened",
      "tradeSizeUsd": "500.00",
      "qualityScore": 82,
      "riskScore": 18,
      "reason": "Opened after every production tradability gate passed.",
      "source": "moonpaper-shadow-v1",
      "mode": "paper",
      "simulated": true,
      "executionEnabled": false
    }
  ],
  "nextCursor": "opaque-value"
}
```

Decision actions map as follows:

| Moonpaper decision | Integration action |
|---|---|
| `opened` | `paper_buy` |
| `closed` | `paper_sell` |
| `entry_rejected` | `paper_skip` |
| `exit_unavailable` | `paper_hold` |
| `scan_empty` | `paper_scan_empty` |
| `error` | `paper_error` |

The endpoint is user-scoped, `no-store`, durably rate-limited, ordered by
timestamp plus UUID, and safe to retry using `sequenceId` as the idempotency
key. It is suitable for a native/server polling adapter. Browser calls from a
different origin are intentionally not enabled with wildcard CORS.

## Boundary with the FOMO product

Moonpaper's side of the integration is now available. Embedding it inside the
third-party FOMO product still requires FOMO's official API/SDK or partner
permission. Once that exists, its adapter needs only to fetch this feed, retain
the cursor, and render or simulate each immutable-mint decision. Real execution
would be a separate project with explicit wallet approval, transaction
simulation, spending limits, and kill switches; this API cannot execute trades.
