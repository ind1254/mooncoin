/* Moonpaper — live Solana research plus simulation-only trading. */
(() => {
  "use strict";

  // ---------- tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (s) => parseFloat(String(s).replace(/,/g, ""));
  const cls = (v) => (num(v) > 0 ? "up" : num(v) < 0 ? "down" : "muted");
  const sign = (v) => (num(v) > 0 ? "+" : "");
  const usd = (s) => {
    const v = num(s);
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
    return `$${v.toFixed(2)}`;
  };
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };

  function toast(message, kind = "") {
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.textContent = message;
    $("toasts").appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  // A local developer can fix a stopped server; a visitor to the deployed app
  // cannot, so the two situations must never share an error message.
  const isLocalDev = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

  const UNREACHABLE = () =>
    isLocalDev()
      ? "Backend offline — start the local backend with: npm run dev"
      : "Moonpaper's server is unreachable. Please try again in a moment.";

  async function api(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch {
      throw new Error(UNREACHABLE());
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      // Server-side faults get a human sentence rather than a bare status
      // code, and never expose internals.
      const fallback =
        res.status >= 500
          ? "Moonpaper's server is having trouble right now. Please try again shortly."
          : `Request failed (${res.status})`;
      const err = new Error(body?.message || fallback);
      err.code = body?.error;
      err.status = res.status;
      throw err;
    }
    return body;
  }
  const post = (path, body) =>
    api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const put = (path, body) =>
    api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // ---------- state ----------
  const state = {
    route: { name: "discover" },
    settings: null,
    filters: { search: "", risk: "", minLiquidityUsd: "", tradeSizeSol: null, feedKind: "recent" },
    gateReports: new Map(),
    modalOpen: false,
  };

  async function loadSettings() {
    const body = await api("/v1/settings");
    state.settings = body.settings;
    if (state.filters.tradeSizeSol == null) state.filters.tradeSizeSol = body.settings.defaultTradeSizeSol;
  }

  // ---------- routing ----------
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, "");
    if (h.startsWith("research/")) return { name: "research", mint: h.slice(9) };
    if (h.startsWith("token/")) return { name: "token", mint: h.slice(6) };
    if (h === "portfolio" || h === "settings" || h === "watchlist" || h === "simulator") return { name: h };
    return { name: "discover" };
  }

  // ---------- session ----------
  // The browser never asserts identity. It asks the server who it is, and the
  // server answers from the httpOnly session cookie the page cannot read.
  const session = { loading: true, authenticated: false, user: null, accountsEnabled: true };

  async function loadSession() {
    try {
      const body = await api("/v1/me");
      session.authenticated = body.authenticated;
      session.user = body.user;
      if (body.accountsEnabled === false) session.accountsEnabled = false;
    } catch {
      session.authenticated = false;
      session.user = null;
    } finally {
      session.loading = false;
      renderAccountArea();
    }
  }

  function renderAccountArea() {
    const el = $("accountArea");
    if (!el) return;
    if (session.loading) {
      el.innerHTML = `<span class="tiny faint">…</span>`;
      return;
    }
    if (!session.accountsEnabled) {
      el.innerHTML = `<span class="tiny faint" title="This deployment has no database configured.">accounts off</span>`;
      return;
    }
    el.innerHTML = session.authenticated
      ? `<div class="account-chip" title="${esc(session.user.email)}">
           <span class="avatar">${esc((session.user.email || "?")[0].toUpperCase())}</span>
           <button class="linkbtn" id="signOutBtn">Sign out</button>
         </div>`
      : `<button class="btn" id="signInBtn" style="padding:7px 14px;font-size:13px">Sign in</button>`;

    const signIn = $("signInBtn");
    if (signIn) signIn.addEventListener("click", () => openAuthModal("signin"));
    const signOut = $("signOutBtn");
    if (signOut)
      signOut.addEventListener("click", async () => {
        await post("/v1/auth/signout").catch(() => undefined);
        session.authenticated = false;
        session.user = null;
        renderAccountArea();
        toast("Signed out");
        render();
      });
  }

  function openAuthModal(mode) {
    const isSignUp = mode === "signup";
    showModal(`
      <h3>${isSignUp ? "Create your Moonpaper account" : "Sign in to Moonpaper"}</h3>
      <div class="tiny muted" style="margin-top:4px">${
        isSignUp
          ? "You start with $100,000 in simulated paper capital. No real money, no wallet, no keys."
          : "Your paper portfolio and watchlist are waiting."
      }</div>
      <div id="authErr" class="error-box hidden"></div>
      <label class="field" style="margin-top:12px">EMAIL</label>
      <input type="text" id="authEmail" autocomplete="email" placeholder="you@example.com">
      <label class="field" style="margin-top:10px">PASSWORD</label>
      <input type="password" id="authPass" autocomplete="${isSignUp ? "new-password" : "current-password"}" placeholder="At least 10 characters">
      <div class="actions">
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn" id="authSubmit">${isSignUp ? "Create account" : "Sign in"}</button>
      </div>
      <div class="tiny faint" style="margin-top:12px;text-align:center">
        ${isSignUp ? "Already have an account?" : "New to Moonpaper?"}
        <button class="linkbtn" id="authSwap">${isSignUp ? "Sign in" : "Create one"}</button>
      </div>
      <div class="sim-notice">Moonpaper is paper trading only. It never connects a wallet, requests keys, or moves real assets.</div>
    `);

    $("authSwap").addEventListener("click", () => openAuthModal(isSignUp ? "signin" : "signup"));

    const submit = async () => {
      const email = $("authEmail").value.trim();
      const password = $("authPass").value;
      const err = $("authErr");
      err.classList.add("hidden");
      const btn = $("authSubmit");
      btn.disabled = true;
      btn.textContent = "Working…";
      try {
        const body = await post(`/v1/auth/${isSignUp ? "signup" : "signin"}`, { email, password });
        session.authenticated = true;
        session.user = body.user;
        closeModal();
        renderAccountArea();
        toast(isSignUp ? "Account created — $100,000 paper capital ready" : "Signed in", "ok");
        render();
      } catch (e) {
        err.textContent = e.message;
        err.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = isSignUp ? "Create account" : "Sign in";
      }
    };

    $("authSubmit").addEventListener("click", submit);
    $("authPass").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    $("authEmail").focus();
  }

  /** Shown wherever a personal feature needs an account. */
  function signInPrompt(what) {
    return `
      <div class="empty">
        <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px">Sign in to use ${esc(what)}</div>
        <div style="max-width:420px;margin:0 auto 14px">Research, risk analysis and live quotes stay free and open to everyone. This part is personal to you, so it needs an account.</div>
        <button class="btn" id="promptSignIn">Create an account</button>
      </div>`;
  }

  function wireSignInPrompt() {
    const b = $("promptSignIn");
    if (b) b.addEventListener("click", () => openAuthModal("signup"));
  }
  window.addEventListener("hashchange", () => {
    state.route = parseHash();
    render();
  });

  document.querySelectorAll("[data-nav]").forEach((btn) =>
    btn.addEventListener("click", () => {
      location.hash = "#/" + btn.dataset.nav;
    }),
  );

  function setActiveTab() {
    document.querySelectorAll("[data-nav]").forEach((b) => {
      const target = state.route.name === "token" || state.route.name === "research" ? "discover" : state.route.name;
      b.classList.toggle("active", b.dataset.nav === target);
    });
  }

  // ---------- chips & shared fragments ----------
  const oppChip = (label) => `<span class="chip ${esc(label)}">${esc(label).toUpperCase()}</span>`;
  const riskChip = (level) => `<span class="chip risk-${esc(level)}">RISK: ${esc(level).toUpperCase()}</span>`;
  const freshness = (ageS, reliability) =>
    `<span class="freshness ${reliability !== "fresh" ? "stale" : ""}">${reliability === "fresh" ? `data ${ageS}s old` : `⚠ data ${ageS}s old (stale)`}</span>`;

  // ---------- provenance & verification vocabulary ----------
  // Plain-language copy lives here, not in the API. The backend returns facts
  // and status codes; how they read to a human is a presentation concern.

  /** Maps a machine source id to a human label and whether it is live data. */
  const SOURCES = {
    "solana-rpc:mainnet": { label: "Solana RPC", live: true, hint: "Read directly from the token's mint account on Solana mainnet." },
    "jupiter:tokens-v2": { label: "Jupiter", live: true, hint: "Live market data from Jupiter's public token API." },
    "jupiter:quote-v1": { label: "Jupiter quote", live: true, hint: "Read-only executable quote from Jupiter." },
    "demo-simulator": { label: "Simulated", live: false, hint: "Generated by Moonpaper's deterministic demo simulator — not real market data." },
    none: { label: "Unavailable", live: false, hint: "No provider supplies this value yet." },
  };

  function sourceInfo(source) {
    return SOURCES[source] ?? { label: source || "Unknown", live: false, hint: "Source not reported." };
  }

  /** Small pill showing where a single value came from. */
  function sourceBadge(source) {
    const s = sourceInfo(source);
    return `<span class="src ${s.live ? "live" : "sim"}" title="${esc(s.hint)}"><i></i>${esc(s.label)}</span>`;
  }

  function gateReportHtml(report, compact = false) {
    const quoteExpired = Boolean(report.quote && Date.now() >= report.quote.expiresAtMs);
    const displayVerdict = quoteExpired && report.verdict !== "blocked" ? "expired" : report.verdict;
    const verdict = quoteExpired
      ? report.verdict === "blocked"
        ? "BLOCKED · QUOTE EXPIRED"
        : "EXPIRED — RUN AGAIN"
      : report.verdict === "eligible"
        ? "ELIGIBLE"
        : report.verdict === "blocked"
          ? "BLOCKED"
          : "NEEDS VERIFICATION";
    const gates = report.gates
      .map((g) => {
        const status = quoteExpired && (g.id === "jupiter_route" || g.id === "price_impact") ? "unavailable" : g.status;
        const detail =
          quoteExpired && (g.id === "jupiter_route" || g.id === "price_impact")
            ? "The underlying route quote expired; run the check again."
            : g.detail;
        const icon = status === "pass" ? "✓" : status === "fail" ? "✕" : status === "warning" ? "!" : "?";
        return `<div class="gate-row ${esc(status)}">
          <span class="gate-icon">${icon}</span>
          <span class="gate-copy"><b>${esc(g.label)}</b><small>${esc(detail)}</small></span>
          ${sourceBadge(g.source)}
        </div>`;
      })
      .join("");
    const route = report.quote
      ? `<div class="gate-route mono">${esc(report.quote.input)} → ${esc(report.quote.output)} · impact ${esc(report.quote.priceImpactPct)}% · ${report.quote.route.map((r) => esc(r.venue)).join(" → ")}</div>`
      : `<div class="gate-route muted">No verified live route is available in this check.</div>`;
    return `<div class="gate-report ${esc(displayVerdict)} ${compact ? "compact" : ""}">
      <div class="gate-report-head"><span class="gate-verdict">${verdict}</span><span class="tiny muted">checked ${ago(report.checkedAtMs)}</span></div>
      <div class="gate-summary">${quoteExpired ? `${esc(report.summary)} The route quote has expired; run the production check again before relying on it.` : esc(report.summary)}</div>
      ${gates}
      ${route}
      <div class="tiny faint gate-policy">Policy: ≥${usd(report.policy.minLiquidityUsd)} liquidity · ≤${esc(report.policy.maxPriceImpactPct)}% impact · market data ≤${esc(report.policy.maxMarketAgeSeconds)}s old. Read-only check; no transaction is sent.</div>
    </div>`;
  }

  function livePaperReportIsUsable(report) {
    return Boolean(report?.eligible && report.quote && Date.now() < report.quote.expiresAtMs);
  }

  function openLivePaperTradeModal(token, amountUsd, report) {
    if (!session.authenticated) return openAuthModal("signup");
    if (!livePaperReportIsUsable(report)) {
      return toast("Run a fresh eligible production check before reviewing this paper entry.", "error");
    }
    const route = report.quote.route.map((hop) => hop.venue).join(" → ");
    showModal(`
      <h3>Review live-quote paper entry — ${esc(token.symbol)}</h3>
      <div class="tiny muted">Canonical mint <span class="mono">${esc(token.mint.slice(0, 10))}…${esc(token.mint.slice(-8))}</span></div>
      <div class="sim-notice">SIMULATION ONLY — the server will rerun every production gate and request a fresh read-only Jupiter quote. No wallet is connected and no transaction is built, signed, or submitted.</div>
      <div id="livePaperErr" class="error-box hidden"></div>
      <div class="kv"><span class="k">Paper cash to spend</span><span class="v mono">$${esc(amountUsd)} USDC</span></div>
      <div class="kv"><span class="k">Current minimum received</span><span class="v mono">${esc(report.quote.minimumOutput)}</span></div>
      <div class="kv"><span class="k">Current route</span><span class="v">${esc(route)}</span></div>
      <div class="kv"><span class="k">Current price impact</span><span class="v mono">${esc(report.quote.priceImpactPct)}%</span></div>
      <div class="kv"><span class="k">Fill rule</span><span class="v">Jupiter minimum output</span></div>
      <div class="tiny faint" style="margin-top:10px">The displayed quote expires in ${Math.max(0, Math.ceil((report.quote.expiresAtMs - Date.now()) / 1000))}s. Confirmation does not trust it: the backend performs the entire check again.</div>
      <div class="actions">
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn" id="confirmLivePaper">Open paper position</button>
      </div>
    `);

    $("confirmLivePaper").addEventListener("click", async () => {
      const button = $("confirmLivePaper");
      const error = $("livePaperErr");
      button.disabled = true;
      button.textContent = "Rechecking gates…";
      error.classList.add("hidden");
      try {
        const body = await post("/v1/me/paper/positions", {
          tokenMint: token.mint,
          amountUsd,
          slippageBps: 50,
        });
        closeModal();
        toast(`${body.position.token.symbol} live-quote paper position opened`, "ok");
        location.hash = "#/portfolio";
        if (state.route.name === "portfolio") render();
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove("hidden");
        button.disabled = false;
        button.textContent = "Retry paper entry";
      }
    });
  }

  function openLivePaperCloseModal(position) {
    const currentValue = position.marketValueUsd === null ? "unavailable" : `$${position.marketValueUsd}`;
    showModal(`
      <h3>Close ${esc(position.token.symbol)} paper position</h3>
      <div class="tiny muted">This closes the entire simulated position using a new exact-size token-to-USDC quote.</div>
      <div class="sim-notice">SIMULATION ONLY — Moonpaper requests a fresh read-only sell quote and credits only its minimum received amount. No real token is sold.</div>
      <div id="livePaperCloseErr" class="error-box hidden"></div>
      <div class="kv"><span class="k">Quantity</span><span class="v mono">${esc(position.quantity)} ${esc(position.token.symbol)}</span></div>
      <div class="kv"><span class="k">Cost basis</span><span class="v mono">$${esc(position.costBasisUsd)}</span></div>
      <div class="kv"><span class="k">Latest marked value</span><span class="v mono">${esc(currentValue)}</span></div>
      <div class="kv"><span class="k">Latest marked P&amp;L</span><span class="v mono ${position.pnlUsd === null ? "muted" : cls(position.pnlUsd)}">${position.pnlUsd === null ? "unavailable" : `${sign(position.pnlUsd)}$${esc(position.pnlUsd)}`}</span></div>
      <div class="tiny faint" style="margin-top:10px">The final paper proceeds can differ from this mark because the close endpoint requests a new quote.</div>
      <div class="actions">
        <button class="btn secondary" data-close>Keep open</button>
        <button class="btn danger" id="confirmLivePaperClose">Close paper position</button>
      </div>
    `);

    $("confirmLivePaperClose").addEventListener("click", async () => {
      const button = $("confirmLivePaperClose");
      const error = $("livePaperCloseErr");
      button.disabled = true;
      button.textContent = "Requesting sell quote…";
      error.classList.add("hidden");
      try {
        const body = await post(`/v1/me/paper/positions/${encodeURIComponent(position.id)}/close`, {
          slippageBps: 50,
        });
        closeModal();
        toast(`${body.position.token.symbol} paper position closed`, "ok");
        render();
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove("hidden");
        button.disabled = false;
        button.textContent = "Retry close";
      }
    });
  }

  /** The six verification states, in user-facing language. */
  // The pill states the outcome, the blurb states the consequence for the
  // user, and the API's `detail` states the technical reason. Keeping those
  // three distinct avoids saying the same thing three times.
  const VERIFICATION = {
    verified: { label: "Verified on Solana", tone: "ok", blurb: "Authority settings were read directly from this token's mint account on-chain." },
    not_found: { label: "Not found on-chain", tone: "warn", blurb: "Nothing could be verified, so the values below fall back to simulated data." },
    unsupported_program: { label: "Unsupported token program", tone: "warn", blurb: "Moonpaper cannot decode this token's program yet, so the values below fall back to simulated data." },
    malformed: { label: "Unreadable account", tone: "warn", blurb: "The account did not match the expected layout, so the values below fall back to simulated data." },
    unavailable: { label: "Verification unavailable", tone: "warn", blurb: "Solana could not be reached, so the values below fall back to simulated data." },
    off: { label: "Live verification off", tone: "muted", blurb: "Moonpaper is running in demo mode. Every value below is simulated." },
  };

  /** Compact list-view badge. Absent in demo mode, where nothing is verified. */
  function verifiedChip(verification) {
    if (!verification) return "";
    const v = VERIFICATION[verification.status] ?? VERIFICATION.off;
    return verification.live
      ? `<span class="chip live-chip" title="${esc(v.blurb)}">✓ ON-CHAIN</span>`
      : `<span class="chip unver-chip" title="${esc(v.blurb)}">UNVERIFIED</span>`;
  }

  function verificationPill(status) {
    const v = VERIFICATION[status] ?? VERIFICATION.off;
    return `<span class="vpill ${v.tone}">${v.tone === "ok" ? "✓" : v.tone === "warn" ? "!" : "○"} ${esc(v.label)}</span>`;
  }

  /**
   * Copy for each risk fact: a friendly label, how to render the value, and a
   * plain-language explanation. Deliberately states facts, not verdicts —
   * a live mint authority is normal for a stablecoin and alarming for an
   * anonymous new token, so the UI describes and lets the score interpret.
   */
  const FACT_COPY = {
    mintAuthorityRevoked: {
      label: "Mint authority",
      term: "Whether someone still has permission to create additional supply.",
      render: (v) =>
        v
          ? { text: "Revoked", dot: "ok", why: "Additional supply can no longer be minted through the original mint authority." }
          : { text: "Active", dot: "attn", why: "An address still has permission to create additional token supply. This is common for stablecoins and managed tokens, and a bigger concern for anonymous new tokens." },
    },
    freezeAuthorityRevoked: {
      label: "Freeze authority",
      term: "Whether an authority can still freeze token accounts.",
      render: (v) =>
        v
          ? { text: "Revoked", dot: "ok", why: "Token accounts can no longer be frozen by the original freeze authority." }
          : { text: "Active", dot: "attn", why: "An authority may still be able to freeze token accounts, which would block transfers for the affected holders." },
    },
    tokenAgeDays: {
      label: "Token age",
      term: "How long this token has existed.",
      render: (v) => ({ text: `${v} days`, dot: v < 30 ? "attn" : "ok", why: v < 30 ? "Newly created tokens have little trading history to judge them by." : "This token has a meaningful trading history." }),
    },
    holderConcentrationPct: {
      label: "Top-10 holder share",
      term: "How much of the supply the ten largest wallets hold.",
      render: (v) => {
        const n = parseFloat(v);
        return { text: `${v}%`, dot: n >= 30 ? "attn" : "ok", why: n >= 30 ? "A small number of wallets hold enough supply to move the price if they sell." : "Supply is spread across many wallets." };
      },
    },
    recentInsiderActivity: {
      label: "Insider movement",
      term: "Recent large transfers by the creator or early holders.",
      render: (v) => (v ? { text: "Detected", dot: "attn", why: "Large developer or early-holder transfers were observed recently." } : { text: "None seen", dot: "ok", why: "No unusual large transfers were observed recently." }),
    },
    dataComplete: {
      label: "Risk data",
      term: "Whether every risk input could be gathered.",
      render: (v) => (v ? { text: "Complete", dot: "ok", why: "All risk inputs for this token were available." } : { text: "Incomplete", dot: "attn", why: "At least one risk input was missing or could not be verified, so this token is scored more cautiously." }),
    },
  };

  /** One fact: label + value + where it came from + what it means. */
  function factRow(key, value, source) {
    const copy = FACT_COPY[key];
    if (!copy || value === undefined || value === null) return "";
    const r = copy.render(value);
    return `
      <div class="fact">
        <div class="fact-head">
          <span class="fact-label">${esc(copy.label)}<span class="info" tabindex="0" role="note" aria-label="${esc(copy.term)}" title="${esc(copy.term)}">i</span></span>
          <span class="fact-value"><i class="dot ${r.dot}"></i>${esc(r.text)}</span>
        </div>
        <div class="fact-meta">${sourceBadge(source)}<span class="fact-why">${esc(r.why)}</span></div>
      </div>`;
  }

  /** The on-chain verification panel for a token. */
  function verificationCard(d) {
    const rf = d.riskFacts;
    const v = rf.onChainVerification;
    const status = v ? v.status : "off";
    const meta = VERIFICATION[status] ?? VERIFICATION.off;
    // No per-field map means nothing was overlaid, so every value is simulated.
    const src = (k) => (rf.fieldSources && rf.fieldSources[k]) || "demo-simulator";

    const decimalsRow =
      v && typeof v.decimalsOnChain === "number"
        ? `<div class="fact">
             <div class="fact-head">
               <span class="fact-label">On-chain decimals<span class="info" tabindex="0" role="note" aria-label="The scaling factor between raw units and whole tokens." title="The scaling factor between raw units and whole tokens.">i</span></span>
               <span class="fact-value"><i class="dot ${v.decimalsMismatch ? "attn" : "ok"}"></i>${v.decimalsOnChain}</span>
             </div>
             <div class="fact-meta">${sourceBadge("solana-rpc:mainnet")}<span class="fact-why">${
               v.decimalsMismatch
                 ? "Does not match the value Moonpaper uses for amounts. Reported here, deliberately not applied — changing it without changing quote math would misstate every amount."
                 : "Matches the value Moonpaper uses when converting raw units to whole tokens."
             }</span></div>
           </div>`
        : "";

    return `
      <div class="card">
        <div class="row spread" style="flex-wrap:wrap;gap:8px">
          <h3>On-chain verification</h3>
          ${verificationPill(status)}
        </div>
        <div class="tiny muted" style="margin-top:6px">${esc(meta.blurb)}</div>
        ${v && v.detail ? `<div class="fallback-note">${esc(v.detail)}</div>` : ""}
        <div class="facts">
          ${factRow("mintAuthorityRevoked", rf.mintAuthorityRevoked, src("mintAuthorityRevoked"))}
          ${factRow("freezeAuthorityRevoked", rf.freezeAuthorityRevoked, src("freezeAuthorityRevoked"))}
          ${decimalsRow}
          ${factRow("tokenAgeDays", rf.tokenAgeDays, src("tokenAgeDays"))}
          ${factRow("holderConcentrationPct", rf.holderConcentrationPct, src("holderConcentrationPct"))}
          ${factRow("recentInsiderActivity", rf.recentInsiderActivity, src("recentInsiderActivity"))}
          ${factRow("dataComplete", rf.dataComplete, src("dataComplete"))}
        </div>
        <div class="freshbar">
          ${v ? `<span title="When Moonpaper last read this token's mint account.">Checked ${ago(v.checkedAtMs)}</span>` : ""}
          ${d.freshness
            .map(
              (f) =>
                `<span class="${f.reliability !== "fresh" ? "warn" : ""}" title="Source: ${esc(sourceInfo(f.source).label)}">${esc(f.field)} ${f.ageSeconds}s${f.reliability !== "fresh" ? " (stale)" : ""}</span>`,
            )
            .join("")}
        </div>
      </div>`;
  }

  // ---------- Token search ----------
  // Rendered imperatively rather than through render(), so typing never
  // rebuilds the page and never races the background refresh.
  const search = { q: "", results: [], loading: false, error: null, open: false, active: -1, dupes: false };
  let searchTimer = null;
  let searchSeq = 0;
  let searchAbort = null;

  const shortMint = (m) => `${m.slice(0, 4)}…${m.slice(-4)}`;

  function searchBoxHtml() {
    return `
      <section class="hero">
        <h1>Research any Solana token</h1>
        <p class="hero-sub">Search by name, ticker, or mint address. Moonpaper verifies what it can on-chain and tells you where every number came from.</p>
        <div class="searchbox" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-owns="searchResults">
          <span class="searchbox-icon" aria-hidden="true">⌕</span>
          <input type="text" id="tokenSearch" autocomplete="off" spellcheck="false"
                 placeholder="Try BONK, JUP, or paste a mint address…"
                 aria-label="Search Solana tokens" aria-controls="searchResults" />
          <button class="searchbox-clear hidden" id="searchClear" aria-label="Clear search">✕</button>
        </div>
        <div class="search-panel hidden" id="searchPanel">
          <div id="searchResults" role="listbox" aria-label="Search results"></div>
        </div>
        <div class="hero-note">Read-only research and paper trading. Moonpaper never connects a wallet, never asks for keys, and never submits a transaction.</div>
      </section>`;
  }

  function resultRowHtml(r, i) {
    const price = r.priceUsd ? `$${esc(r.priceUsd)}` : "—";
    const liq = r.liquidityUsd ? usd(r.liquidityUsd) : "—";
    return `
      <div class="sresult ${i === search.active ? "active" : ""}" role="option" data-mint="${esc(r.mint)}" data-i="${i}" aria-selected="${i === search.active}" tabindex="-1">
        <div class="sresult-icon">${r.iconUrl ? `<img src="${esc(r.iconUrl)}" alt="" loading="lazy" onerror="this.remove()">` : "◎"}</div>
        <div class="sresult-main">
          <div class="sresult-top">
            <span class="sresult-sym">${esc(r.symbol)}</span>
            <span class="sresult-name">${esc(r.name)}</span>
            ${r.verifiedByProvider ? `<span class="chip live-chip" title="On Jupiter's verified token list">LISTED</span>` : `<span class="chip unver-chip" title="Not on the provider's verified list">UNLISTED</span>`}
          </div>
          <div class="sresult-meta mono">${esc(shortMint(r.mint))} · ${price} · liq ${liq}${r.holderCount ? ` · ${r.holderCount.toLocaleString()} holders` : ""}</div>
        </div>
      </div>`;
  }

  function renderSearchPanel() {
    const panel = $("searchPanel");
    const list = $("searchResults");
    if (!panel || !list) return;
    const box = document.querySelector(".searchbox");

    if (!search.open) {
      panel.classList.add("hidden");
      if (box) box.setAttribute("aria-expanded", "false");
      return;
    }
    panel.classList.remove("hidden");
    if (box) box.setAttribute("aria-expanded", "true");

    if (search.loading) {
      list.innerHTML = `<div class="sstate"><div class="spinner"></div>Searching Solana tokens…</div>`;
      return;
    }
    if (search.error) {
      list.innerHTML = `<div class="sstate error">⚠ ${esc(search.error)}</div>`;
      return;
    }
    if (search.q.trim().length < 2) {
      list.innerHTML = `<div class="sstate">Type at least 2 characters to search.</div>`;
      return;
    }
    if (search.results.length === 0) {
      list.innerHTML = `<div class="sstate">No tokens matched “${esc(search.q)}”.<br><span class="tiny faint">If you pasted a mint address, check it is a valid Solana address.</span></div>`;
      return;
    }
    list.innerHTML =
      (search.dupes
        ? `<div class="sdupe">Several of these tokens share a ticker. Check the mint address before choosing — the address is the only unique identifier.</div>`
        : "") + search.results.map(resultRowHtml).join("");

    list.querySelectorAll(".sresult").forEach((el) =>
      el.addEventListener("mousedown", (e) => {
        e.preventDefault(); // fire before the input's blur closes the panel
        openResearch(el.dataset.mint);
      }),
    );
  }

  function openResearch(mint) {
    search.open = false;
    renderSearchPanel();
    location.hash = `#/research/${mint}`;
  }

  async function runSearch(q) {
    const seq = ++searchSeq;
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    search.loading = true;
    search.error = null;
    renderSearchPanel();
    try {
      const res = await fetch(`/v1/search?q=${encodeURIComponent(q)}`, { signal: searchAbort.signal });
      const body = await res.json().catch(() => null);
      if (seq !== searchSeq) return; // a newer keystroke superseded this one
      if (!res.ok) {
        search.error =
          body?.error === "PROVIDER_RATE_LIMITED"
            ? "Search is rate limited right now. Try again in a few seconds."
            : body?.message || "Token search is unavailable right now.";
        search.results = [];
      } else {
        search.results = body.results;
        search.dupes = body.duplicateSymbols;
        search.active = -1;
      }
    } catch (err) {
      if (err.name === "AbortError" || seq !== searchSeq) return;
      search.error = "Could not reach the search service.";
      search.results = [];
    } finally {
      if (seq === searchSeq) {
        search.loading = false;
        renderSearchPanel();
      }
    }
  }

  function wireSearch() {
    const input = $("tokenSearch");
    if (!input) return;
    input.value = search.q;

    input.addEventListener("input", () => {
      search.q = input.value;
      search.open = true;
      $("searchClear").classList.toggle("hidden", !search.q);
      clearTimeout(searchTimer);
      if (search.q.trim().length < 2) {
        search.results = [];
        search.loading = false;
        renderSearchPanel();
        return;
      }
      // Debounce so a burst of keystrokes costs one request, not one each.
      searchTimer = setTimeout(() => runSearch(search.q.trim()), 300);
    });

    input.addEventListener("focus", () => {
      if (search.q) {
        search.open = true;
        renderSearchPanel();
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        search.open = false;
        renderSearchPanel();
        input.blur();
        return;
      }
      if (!search.open || search.results.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        search.active = (search.active + dir + search.results.length) % search.results.length;
        renderSearchPanel();
        document.querySelector(".sresult.active")?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = search.active >= 0 ? search.results[search.active] : search.results[0];
        if (pick) openResearch(pick.mint);
      }
    });

    $("searchClear").addEventListener("click", () => {
      search.q = "";
      search.results = [];
      search.open = false;
      input.value = "";
      $("searchClear").classList.add("hidden");
      renderSearchPanel();
      input.focus();
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".hero") && search.open) {
        search.open = false;
        renderSearchPanel();
      }
    });

    renderSearchPanel();
  }

  // ---------- Discover ----------
  async function renderDiscover(container) {
    const params = new URLSearchParams({ kind: state.filters.feedKind, limit: "60" });
    if (state.filters.minLiquidityUsd) params.set("minLiquidityUsd", state.filters.minLiquidityUsd);
    if (state.filters.search) params.set("search", state.filters.search);

    const [feed, portfolio, personalWatchlist] = await Promise.all([
      api(`/v1/feed?${params}`),
      api("/v1/paper/portfolio"),
      session.authenticated ? api("/v1/me/watchlist") : Promise.resolve({ items: [] }),
    ]);
    const s = portfolio.stats;
    const unrl = num(s.totalUnrealizedPnlSol);
    const watchedMints = new Set((personalWatchlist.items || []).map((item) => item.tokenMint));

    container.innerHTML = `
      ${searchBoxHtml()}
      <div class="live-feed-head">
        <div>
          <div class="eyebrow">LIVE SOLANA DISCOVERY</div>
          <h2>${state.filters.feedKind === "recent" ? "New token pools" : "Trending now"}</h2>
          <p class="muted small">${esc(feed.notice)}</p>
        </div>
        <div class="feed-pulse ${feed.reliability !== "fresh" ? "stale" : ""}"><i></i>${feed.reliability === "fresh" ? "LIVE" : "DELAYED"} · updated ${feed.ageSeconds}s ago</div>
      </div>

      <div class="feed-tabs" role="tablist" aria-label="Live token feed">
        <button class="${state.filters.feedKind === "recent" ? "active" : ""}" data-feed="recent" role="tab">New</button>
        <button class="${state.filters.feedKind === "trending" ? "active" : ""}" data-feed="trending" role="tab">Trending 5m</button>
      </div>

      <div class="filters live-filters">
        <div class="search"><label class="field">FILTER THIS FEED</label><input type="text" id="fSearch" placeholder="Token, name, or mint…" value="${esc(state.filters.search)}"></div>
        <div><label class="field">MIN LIQUIDITY</label><select id="fLiq">
          <option value="">Any / newly detected</option>
          <option value="10000" ${state.filters.minLiquidityUsd === "10000" ? "selected" : ""}>$10k+</option>
          <option value="50000" ${state.filters.minLiquidityUsd === "50000" ? "selected" : ""}>$50k+</option>
          <option value="250000" ${state.filters.minLiquidityUsd === "250000" ? "selected" : ""}>$250k+</option>
          <option value="1000000" ${state.filters.minLiquidityUsd === "1000000" ? "selected" : ""}>$1M+</option>
        </select></div>
        <div class="feed-source">${sourceBadge(feed.source)}<span class="tiny muted">Production floor: ${usd(feed.policy.minLiquidityUsd)} liquidity · ${esc(feed.policy.maxPriceImpactPct)}% max impact · ${esc(feed.policy.maxMarketAgeSeconds)}s max market age.</span></div>
      </div>

      <div id="liveFeedList">${feed.tokens.length ? "" : `<div class="empty">No live tokens match these filters.</div>`}</div>

      <h2 class="portfolio-heading">Paper portfolio <span class="tiny muted">simulation-only learning account</span></h2>
      <div class="summary-strip">
        <div class="stat"><div class="k">VIRTUAL BALANCE</div><div class="v mono">${esc(portfolio.cashSol)} SOL</div><div class="s">simulated cash</div></div>
        <div class="stat"><div class="k">PORTFOLIO VALUE</div><div class="v mono">${esc(portfolio.totalValueSol)} SOL</div><div class="s">started with ${esc(portfolio.startingBalanceSol)} SOL</div></div>
        <div class="stat"><div class="k">OPEN P&amp;L</div><div class="v mono ${unrl > 0 ? "up" : unrl < 0 ? "down" : ""}">${sign(s.totalUnrealizedPnlSol)}${esc(s.totalUnrealizedPnlSol)} SOL</div><div class="s">${s.openCount} open position${s.openCount === 1 ? "" : "s"}</div></div>
        <div class="stat"><div class="k">WIN RATE</div><div class="v mono">${s.closedCount ? s.winRatePct + "%" : "—"}</div><div class="s">${s.closedCount} closed paper trades</div></div>
      </div>
    `;

    const listEl = container.querySelector("#liveFeedList");
    for (const token of feed.tokens) {
      listEl.appendChild(liveTokenCard({ ...token, inWatchlist: watchedMints.has(token.mint) }));
    }

    container.querySelectorAll("[data-feed]").forEach((button) => {
      button.addEventListener("click", () => {
        state.filters.feedKind = button.dataset.feed;
        state.filters.search = "";
        render();
      });
    });

    container.querySelector("#fSearch").addEventListener("change", (e) => {
      state.filters.search = e.target.value.trim();
      render();
    });
    container.querySelector("#fLiq").addEventListener("change", (e) => {
      state.filters.minLiquidityUsd = e.target.value;
      render();
    });

    // Wired after the view is attached, since it binds document-level events.
    return wireSearch;
  }

  function liveTokenCard(token) {
    const div = document.createElement("article");
    div.className = "opp-card live-token-card";
    const assessment = token.assessment;
    const firstSeen = token.firstPoolAtMs ? ago(token.firstPoolAtMs) : "time unavailable";
    const price = token.priceUsd == null ? "—" : `$${token.priceUsd}`;
    const liquidity = token.liquidityUsd == null ? "not reported" : usd(token.liquidityUsd);
    const vol5m = token.fiveMinuteVolumeUsd == null ? "—" : usd(token.fiveMinuteVolumeUsd);
    const change5m = token.stats5m.priceChangePct;
    const statusLabel = assessment.status === "active" ? "CATALOG READY" : assessment.status === "thin" ? "THIN" : assessment.status === "stale" ? "STALE" : "DETECTED";
    const warnings = (assessment.warnings || [])
      .slice(0, 3)
      .map((warning) => `<span class="fx negative">${esc(warning)}</span>`)
      .join("");
    const icon = token.iconUrl
      ? `<img src="${esc(token.iconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span aria-hidden="true">◉</span>`;
    const storedGateReport = state.gateReports.get(token.mint);
    const paperReady = livePaperReportIsUsable(storedGateReport);

    div.innerHTML = `
      <div class="opp-emoji token-icon">${icon}</div>
      <div class="opp-main">
        <div class="opp-title">
          <span class="sym">${esc(token.symbol)}</span>
          <span class="muted small">${esc(token.name)}</span>
          <span class="chip ${assessment.status === "active" ? "live-chip" : "unver-chip"}">${statusLabel}</span>
          ${riskChip(assessment.riskLevel)}
        </div>
        <div class="mint-line mono" title="${esc(token.mint)}">${esc(token.mint.slice(0, 8))}…${esc(token.mint.slice(-6))} · first pool ${firstSeen}${token.launchpad ? ` · ${esc(token.launchpad)}` : ""}</div>
        <div class="opp-metrics mono">
          <span>Price <b>${esc(price)}</b></span>
          <span>5m <b class="${cls(change5m || 0)}">${change5m == null ? "—" : `${sign(change5m)}${esc(change5m)}%`}</b></span>
          <span>Vol 5m <b>${esc(vol5m)}</b></span>
          <span>Liquidity <b>${esc(liquidity)}</b></span>
          <span>Traders 5m <b>${token.stats5m.traders ?? "—"}</b></span>
        </div>
        <div class="opp-why">${warnings || `<span class="fx positive">No immediate catalog warnings</span>`}</div>
        <div class="eligibility tiny muted">${esc(assessment.eligibility)}</div>
        <div class="gate-check-out">${storedGateReport ? gateReportHtml(storedGateReport, true) : ""}</div>
      </div>
      <div class="opp-side">
        <div class="opp-score"><div class="n">${assessment.qualityScore}</div><div class="d">RESEARCH / 100</div></div>
        ${freshness(token.updatedAgeSeconds ?? 999, token.reliability)}
        <div class="row" style="flex-wrap:wrap;justify-content:flex-end">
          <button class="star ${token.inWatchlist ? "active" : ""}" title="Watchlist" aria-label="Toggle watchlist">★</button>
          <button class="btn secondary sm-gates">${storedGateReport ? "Check again" : "Check $100 eligibility"}</button>
          <button class="btn sm-paper ${paperReady ? "" : "hidden"}">Paper buy $100</button>
          <button class="btn sm-research">Research + live quote</button>
        </div>
      </div>
    `;

    div.querySelector(".sm-research").addEventListener("click", () => (location.hash = `#/research/${token.mint}`));
    div.querySelector(".sm-gates").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const out = div.querySelector(".gate-check-out");
      const paperButton = div.querySelector(".sm-paper");
      button.disabled = true;
      button.textContent = "Checking…";
      out.innerHTML = `<div class="sstate"><div class="spinner"></div>Verifying route and chain…</div>`;
      try {
        const report = await api(`/v1/tradability/${encodeURIComponent(token.mint)}?amountUsd=100&slippageBps=50`);
        state.gateReports.set(token.mint, report);
        out.innerHTML = gateReportHtml(report, true);
        paperButton.classList.toggle("hidden", !livePaperReportIsUsable(report));
        button.textContent = "Check again";
        if (report.quote) {
          setTimeout(() => {
            if (out.isConnected) {
              out.innerHTML = gateReportHtml(report, true);
              paperButton.classList.add("hidden");
            }
          }, Math.max(0, report.quote.expiresAtMs - Date.now()) + 100);
        }
      } catch (err) {
        out.innerHTML = `<div class="unavail-block"><div class="unavail-title">Eligibility check unavailable</div><div class="tiny muted">${esc(err.message)}</div></div>`;
        button.textContent = "Retry eligibility";
      } finally {
        button.disabled = false;
      }
      event.stopPropagation();
    });
    div.querySelector(".sm-paper").addEventListener("click", (event) => {
      openLivePaperTradeModal(token, "100", state.gateReports.get(token.mint));
      event.stopPropagation();
    });
    div.querySelector(".star").addEventListener("click", async (event) => {
      if (!session.authenticated) {
        openAuthModal("signup");
        event.stopPropagation();
        return;
      }
      try {
        if (token.inWatchlist) {
          await api(`/v1/me/watchlist/${encodeURIComponent(token.mint)}`, { method: "DELETE" });
          toast(`${token.symbol} removed from your watchlist`);
        } else {
          await post("/v1/me/watchlist", { tokenMint: token.mint });
          toast(`${token.symbol} added to your watchlist`, "ok");
        }
        render();
      } catch (err) {
        toast(err.message, "error");
      }
      event.stopPropagation();
    });
    return div;
  }

  function oppCard(o) {
    const div = document.createElement("div");
    div.className = "opp-card";
    const why = (o.whyRanks || [])
      .slice(0, 3)
      .map((f) => `<span class="fx ${esc(f.direction)}" title="${esc(f.detail)}">${esc(f.label)}</span>`)
      .join("");
    div.innerHTML = `
      <div class="opp-emoji">${esc(o.token.emoji)}</div>
      <div class="opp-main">
        <div class="opp-title">
          <span class="sym">${esc(o.token.symbol)}</span>
          <span class="muted small">${esc(o.token.name)}</span>
          ${oppChip(o.opportunityLabel)} ${riskChip(o.riskLevel)} ${verifiedChip(o.verification)}
        </div>
        <div class="opp-metrics mono">
          <span>Price <b>$${esc(o.priceUsd)}</b></span>
          <span>1h <b class="${cls(o.change1hPct)}">${sign(o.change1hPct)}${esc(o.change1hPct)}%</b></span>
          <span>Vol 1h <b>${usd(o.volume1hUsd)}</b> <b class="${cls(o.volumeChange1hPct)}">(${sign(o.volumeChange1hPct)}${esc(o.volumeChange1hPct)}%)</b></span>
          <span>Liquidity <b>${usd(o.liquidityUsd)}</b></span>
          ${o.bestRoute ? `<span>Impact <b>${esc(o.bestRoute.priceImpactPct)}%</b> via ${esc(o.bestRoute.venueName)}</span>` : `<span class="warn">No route</span>`}
        </div>
        <div class="opp-why">${why}</div>
      </div>
      <div class="opp-side">
        <div class="opp-score"><div class="n">${o.scores.opportunity}</div><div class="d">QUALITY / 100</div></div>
        ${freshness(o.dataAgeSeconds, o.dataReliability)}
        <div class="row">
          <button class="star ${o.inWatchlist ? "active" : ""}" title="Watchlist" aria-label="Toggle watchlist">★</button>
          <button class="btn secondary sm-analyze">Analyze</button>
          <button class="btn sm-trade">Paper trade</button>
        </div>
      </div>
    `;
    div.querySelector(".sm-analyze").addEventListener("click", () => (location.hash = `#/token/${o.token.mint}`));
    div.querySelector(".sm-trade").addEventListener("click", () => openTradeModal(o.token.mint));
    div.querySelector(".star").addEventListener("click", async (e) => {
      try {
        const body = await post("/v1/watchlist", { mint: o.token.mint, watched: !o.inWatchlist });
        state.settings = body.settings;
        render();
      } catch (err) {
        toast(err.message, "error");
      }
      e.stopPropagation();
    });
    return div;
  }

  // ---------- Token research (any Solana token) ----------
  const metricRow = (label, value, source, hint) => `
    <div class="kv">
      <span class="k">${esc(label)}${hint ? `<span class="info" tabindex="0" role="note" aria-label="${esc(hint)}" title="${esc(hint)}">i</span>` : ""}</span>
      <span class="v mono">${value === null || value === undefined ? `<span class="unavail">Unavailable</span>` : value}${source ? ` ${sourceBadge(source)}` : ""}</span>
    </div>`;

  function riskFactorHtml(f) {
    const statusChip =
      f.status === "verified"
        ? `<span class="fstatus verified" title="Read directly from the blockchain">Verified on-chain</span>`
        : f.status === "reported"
          ? `<span class="fstatus reported" title="Reported by a market-data provider">Reported</span>`
          : `<span class="fstatus unavailable" title="No provider supplies this yet">Unavailable</span>`;
    return `
      <div class="rfactor ${esc(f.direction)}">
        <div class="rfactor-head">
          <span class="rfactor-label">${esc(f.label)}</span>
          <span class="rfactor-right">${statusChip}${f.points > 0 ? `<span class="rpoints">+${f.points}</span>` : ""}</span>
        </div>
        <div class="rfactor-fact">${esc(f.fact)}</div>
        <div class="rfactor-interp"><span class="interp-tag">What it may mean</span> ${esc(f.interpretation)}</div>
        <div class="rfactor-src">${sourceBadge(f.source)}</div>
      </div>`;
  }

  async function renderResearch(container, mint) {
    const d = await api(`/v1/research/${encodeURIComponent(mint)}`);
    const v = d.verification;
    const status = v ? v.status : "off";
    const meta = VERIFICATION[status] ?? VERIFICATION.off;
    const m = d.market;
    const risk = d.risk;

    const authorityRow = (label, revoked, copyKey) => {
      const copy = FACT_COPY[copyKey];
      const r = revoked === null ? null : copy.render(revoked);
      return `
        <div class="fact">
          <div class="fact-head">
            <span class="fact-label">${esc(copy.label)}<span class="info" tabindex="0" role="note" aria-label="${esc(copy.term)}" title="${esc(copy.term)}">i</span></span>
            <span class="fact-value">${r ? `<i class="dot ${r.dot}"></i>${esc(r.text)}` : `<span class="unavail">Unknown</span>`}</span>
          </div>
          <div class="fact-meta">${sourceBadge(d.authorities.source)}<span class="fact-why">${r ? esc(r.why) : "Could not be read from the chain, so it is not asserted either way."}</span></div>
        </div>`;
    };

    container.innerHTML = `
      <button class="back" id="backBtn">← Back to search</button>

      <div class="research-head">
        <div class="rh-icon">${d.iconUrl ? `<img src="${esc(d.iconUrl)}" alt="" onerror="this.remove()">` : "◎"}</div>
        <div class="rh-main">
          <div class="row" style="flex-wrap:wrap;gap:8px">
            <h2>${esc(d.symbol)}</h2>
            <span class="muted">${esc(d.name)}</span>
            ${d.verifiedByProvider ? `<span class="chip live-chip">LISTED</span>` : `<span class="chip unver-chip">UNLISTED</span>`}
            <span class="chip risk-${esc(risk.level)}">RISK: ${esc(risk.level.toUpperCase())}</span>
            <button class="btn secondary" id="watchBtn" style="padding:4px 12px;font-size:12px">☆ Watch</button>
          </div>
          <div class="rh-mint mono" title="The mint address is this token's only unique identifier">${esc(d.mint)}</div>
          <div class="rh-sub tiny muted">${d.decimals} decimals · ${esc((d.tokenProgram || "unknown program").slice(0, 24))}${d.tokenProgram && d.tokenProgram.length > 24 ? "…" : ""} · identity from ${esc(sourceInfo(d.identitySource).label)}</div>
        </div>
        <div class="rh-price">
          <div class="price mono">${m.priceUsd ? "$" + esc(m.priceUsd) : "—"}</div>
          <div class="small mono">${m.change24hPct !== null ? `<span class="${cls(m.change24hPct)}">${sign(m.change24hPct)}${esc(m.change24hPct)}% 24h</span>` : `<span class="unavail">no price data</span>`}</div>
        </div>
      </div>

      <div class="detail-grid">
        <div class="grid">
          <div class="card">
            <div class="row spread" style="flex-wrap:wrap;gap:8px">
              <h3>On-chain verification</h3>
              ${verificationPill(status)}
            </div>
            <div class="tiny muted" style="margin-top:6px">${esc(meta.blurb)}</div>
            ${v && v.detail ? `<div class="fallback-note">${esc(v.detail)}</div>` : ""}
            ${
              d.authorities.providerAgreement === "disagrees"
                ? `<div class="fallback-note">Jupiter's audit disagrees with the chain about this token's authorities. Moonpaper shows the chain, which is authoritative.</div>`
                : ""
            }
            <div class="facts">
              ${authorityRow("Mint authority", d.authorities.mintAuthorityRevoked, "mintAuthorityRevoked")}
              ${authorityRow("Freeze authority", d.authorities.freezeAuthorityRevoked, "freezeAuthorityRevoked")}
              ${
                v && typeof v.decimalsOnChain === "number"
                  ? `<div class="fact">
                       <div class="fact-head">
                         <span class="fact-label">On-chain decimals<span class="info" tabindex="0" role="note" aria-label="The scaling factor between raw units and whole tokens." title="The scaling factor between raw units and whole tokens.">i</span></span>
                         <span class="fact-value"><i class="dot ${v.decimalsMismatch ? "attn" : "ok"}"></i>${v.decimalsOnChain}</span>
                       </div>
                       <div class="fact-meta">${sourceBadge("solana-rpc:mainnet")}<span class="fact-why">${v.decimalsMismatch ? "Disagrees with the token list, which is worth knowing before trusting any amount shown elsewhere." : "Matches what the token list reports."}</span></div>
                     </div>`
                  : ""
              }
            </div>
            <div class="freshbar">
              ${v ? `<span>Checked ${ago(v.checkedAtMs)}</span>` : ""}
              <span>Market data ${ago(d.fetchedAtMs)}</span>
              <span>Agreement with token list: ${esc(d.authorities.providerAgreement.replace("_", " "))}</span>
            </div>
          </div>

          <div class="card">
            <h3>Risk breakdown</h3>
            <div class="riskscore">
              <div class="riskscore-num ${esc(risk.level)}">${risk.score}<span>/100</span></div>
              <div class="riskscore-side">
                <div class="riskscore-level">${esc(risk.level.toUpperCase())} RISK</div>
                <div class="tiny faint">${esc(risk.method)}</div>
              </div>
            </div>
            <div class="rfactors">${risk.factors.map(riskFactorHtml).join("")}</div>
          </div>
        </div>

        <div class="grid">
          <div class="card">
            <h3>Market</h3>
            <div class="tiny muted" style="margin-bottom:6px">Live values from ${esc(sourceInfo(m.source).label)}. Anything unavailable is shown as such rather than estimated.</div>
            ${metricRow("Price", m.priceUsd ? "$" + esc(m.priceUsd) : null, m.source)}
            ${metricRow("Liquidity", m.liquidityUsd ? usd(m.liquidityUsd) : null, m.source, "How much capital is available to trade against.")}
            ${metricRow("Market cap", m.marketCapUsd ? usd(m.marketCapUsd) : null, m.source)}
            ${metricRow("Fully diluted value", m.fdvUsd ? usd(m.fdvUsd) : null, m.source, "Value if the entire supply were circulating.")}
            ${metricRow("Holders", m.holderCount !== null ? m.holderCount.toLocaleString() : null, m.source)}
            ${metricRow("Top holders", m.topHolderPct !== null ? esc(m.topHolderPct) + "%" : null, m.source, "Share of supply held by the largest wallets.")}
            ${metricRow("Change 1h", m.change1hPct !== null ? `<span class="${cls(m.change1hPct)}">${sign(m.change1hPct)}${esc(m.change1hPct)}%</span>` : null, m.source)}
            ${metricRow("Buy volume 24h", m.buyVolume24hUsd ? usd(m.buyVolume24hUsd) : null, m.source)}
            ${metricRow("Sell volume 24h", m.sellVolume24hUsd ? usd(m.sellVolume24hUsd) : null, m.source)}
            ${metricRow("Trades 24h", m.numBuys24h !== null ? `${m.numBuys24h.toLocaleString()} buys / ${(m.numSells24h ?? 0).toLocaleString()} sells` : null, m.source)}
          </div>

          <div class="card">
            <h3>Production eligibility &amp; live quote</h3>
            <div class="tiny muted" style="margin-top:4px">Run every production gate for this mint and exact USDC size, or request the raw read-only Jupiter quote by itself.</div>
            <label class="field" style="margin-top:12px">AMOUNT (USDC)</label>
            <div class="row" style="flex-wrap:wrap">
              <input type="text" id="quoteAmt" value="100" inputmode="decimal" placeholder="100">
              <button class="btn" id="eligibilityBtn" style="white-space:nowrap">Run production check</button>
              <button class="btn" id="quoteBtn" style="white-space:nowrap">Get quote</button>
              <button class="btn hidden" id="paperTradeLiveBtn" style="white-space:nowrap">Review paper entry</button>
            </div>
            <div id="eligibilityOut"></div>
            <div id="quoteOut"></div>
            ${
              d.simulation.available
                ? `<button class="btn secondary" id="simBtn" style="width:100%;margin-top:10px">Open the simulator for this token</button>`
                : ""
            }
            <div class="sim-notice">Paper simulation only. No blockchain transaction will be submitted, no wallet is connected, and no keys are ever requested.</div>
          </div>
        </div>
      </div>`;

    container.querySelector("#backBtn").addEventListener("click", () => (location.hash = "#/"));

    container.querySelector("#watchBtn").addEventListener("click", async () => {
      if (!session.authenticated) return openAuthModal("signup");
      try {
        await post("/v1/me/watchlist", { tokenMint: d.mint });
        toast(`${d.symbol} added to your watchlist`, "ok");
        const b = $("watchBtn");
        if (b) {
          b.textContent = "★ Watching";
          b.disabled = true;
        }
      } catch (err) {
        toast(err.message, "error");
      }
    });

    const simBtn = container.querySelector("#simBtn");
    if (simBtn) simBtn.addEventListener("click", () => (location.hash = `#/token/${d.mint}`));

    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    let quoteTimer = null;
    let eligibilityTimer = null;
    let lastEligibility = null;

    async function runEligibility() {
      const out = $("eligibilityOut");
      const button = $("eligibilityBtn");
      const amt = $("quoteAmt").value.trim();
      button.disabled = true;
      button.textContent = "Checking…";
      clearInterval(eligibilityTimer);
      out.innerHTML = `<div class="sstate"><div class="spinner"></div>Checking market freshness, liquidity, ticker ambiguity, mint authorities, route, and impact…</div>`;
      try {
        const params = new URLSearchParams({ amountUsd: amt, slippageBps: "50" });
        const report = await api(`/v1/tradability/${encodeURIComponent(d.mint)}?${params}`);
        lastEligibility = report;
        out.innerHTML = gateReportHtml(report);
        $("paperTradeLiveBtn").classList.toggle("hidden", !livePaperReportIsUsable(report));
        eligibilityTimer = setInterval(() => {
          const current = $("eligibilityOut");
          if (!current) return clearInterval(eligibilityTimer);
          current.innerHTML = gateReportHtml(report);
          const paperButton = $("paperTradeLiveBtn");
          if (paperButton) paperButton.classList.toggle("hidden", !livePaperReportIsUsable(report));
        }, 1_000);
      } catch (err) {
        lastEligibility = null;
        $("paperTradeLiveBtn").classList.add("hidden");
        out.innerHTML = `<div class="unavail-block"><div class="unavail-title">Production check unavailable</div><div class="tiny muted">${esc(err.message)}</div></div>`;
      } finally {
        button.disabled = false;
        button.textContent = "Run production check";
      }
    }

    async function getQuote() {
      // Document lookups, not container lookups: render() moves these nodes
      // into the live view, leaving `container` empty.
      const out = $("quoteOut");
      const amt = $("quoteAmt").value.trim();
      clearInterval(quoteTimer);
      out.innerHTML = `<div class="sstate"><div class="spinner"></div>Requesting a live quote…</div>`;
      try {
        const params = new URLSearchParams({ inputMint: USDC, outputMint: d.mint, amount: amt, slippageBps: "50" });
        const q = await api(`/v1/quote?${params}`);
        renderQuote(q);
      } catch (err) {
        // No fallback on purpose: a made-up fill price would be misleading.
        out.innerHTML = `<div class="unavail-block">
            <div class="unavail-title">Quote unavailable</div>
            <div class="tiny muted">${esc(err.message)}</div>
            <div class="tiny faint" style="margin-top:8px">Moonpaper will not substitute a simulated price here. A quote decides the hypothetical fill, so an invented one would make the simulation meaningless.</div>
          </div>`;
      }
    }

    function renderQuote(q) {
      const out = $("quoteOut");
      const c = q.quote;
      const route = c.route.map((r) => `${esc(r.venue)}${r.percent < 100 ? ` ${r.percent}%` : ""}`).join(" → ");
      out.innerHTML = `
        <div class="quote-card">
          <div class="quote-head">
            <span class="quote-title">Live quote</span>
            <span class="quote-age" id="quoteAge">just now</span>
          </div>
          <div class="kv"><span class="k">You pay</span><span class="v mono">${esc(c.inAmount)} ${esc(q.input.symbol)}</span></div>
          <div class="kv"><span class="k">Expected to receive</span><span class="v mono">${esc(c.outAmount)} ${esc(q.output.symbol)}</span></div>
          <div class="kv"><span class="k">Minimum received<span class="info" tabindex="0" title="The least you would get if the price moved against you by your full slippage tolerance.">i</span></span><span class="v mono">${esc(c.minOutAmount)} ${esc(q.output.symbol)}</span></div>
          <div class="kv"><span class="k">Price impact<span class="info" tabindex="0" title="How much this trade size would move the execution price.">i</span></span><span class="v mono">${esc(c.priceImpactPct)}%</span></div>
          <div class="kv"><span class="k">Slippage assumption</span><span class="v mono">${esc(c.slippagePct)}%</span></div>
          <div class="kv"><span class="k">Route</span><span class="v">${route || "—"}</span></div>
          ${c.swapUsdValue ? `<div class="kv"><span class="k">Notional</span><span class="v mono">$${esc(c.swapUsdValue)}</span></div>` : ""}
          <div class="quote-prov">
            ${sourceBadge("jupiter:quote-v1")}
            <span class="tiny faint">${esc(c.freshnessPolicy)}</span>
          </div>
          <div class="quote-facts">
            <div><span class="interp-tag">Fact</span> Jupiter quoted ${esc(c.outAmount)} ${esc(q.output.symbol)} for ${esc(c.inAmount)} ${esc(q.input.symbol)} at ${new Date(c.retrievedAtMs).toLocaleTimeString()}.</div>
            <div style="margin-top:5px"><span class="interp-tag">Simulation</span> Moonpaper would record that quote as the hypothetical execution price. Nothing is sent to Solana.</div>
          </div>
        </div>`;

      // Freshness must be visible and must decay in front of the user.
      const tick = () => {
        const el = $("quoteAge");
        if (!el) return clearInterval(quoteTimer);
        const age = Math.round((Date.now() - c.retrievedAtMs) / 1000);
        const expired = Date.now() >= c.expiresAtMs;
        el.textContent = expired ? "expired — request a new quote" : `${age}s old`;
        el.className = "quote-age" + (expired ? " expired" : age > 10 ? " aging" : "");
      };
      tick();
      quoteTimer = setInterval(tick, 1000);
    }

    container.querySelector("#quoteBtn").addEventListener("click", getQuote);
    container.querySelector("#eligibilityBtn").addEventListener("click", runEligibility);
    container.querySelector("#paperTradeLiveBtn").addEventListener("click", () => {
      openLivePaperTradeModal(d, $("quoteAmt").value.trim(), lastEligibility);
    });
    container.querySelector("#quoteAmt").addEventListener("keydown", (e) => {
      if (e.key === "Enter") runEligibility();
    });
  }

  // ---------- Token detail ----------
  async function renderToken(container, mint) {
    const size = state.filters.tradeSizeSol ?? 10;
    const d = await api(`/v1/tokens/${encodeURIComponent(mint)}?tradeSizeSol=${size}`);
    const sc = d.scores;

    const scoreRow = (name, pillar, isRisk = false) => `
      <div class="score-row">
        <div class="head"><span>${name}</span><span class="mono">${pillar.score}/100</span></div>
        <div class="meter ${isRisk ? "risk" : ""}"><i style="width:${pillar.score}%"></i></div>
        <button class="evidence-toggle" data-ev="${name}">Why? ▾</button>
        <ul class="evidence hidden" data-evlist="${name}">
          ${pillar.factors.map((f) => `<li class="fx ${esc(f.direction)}">${esc(f.detail)}</li>`).join("")}
        </ul>
      </div>`;

    const routeRow = (r, best) => `
      <tr class="${best ? "best" : ""}">
        <td>${best ? "★ " : ""}${esc(r.venueName)}</td>
        <td class="mono">${esc(r.outDisplay)}</td>
        <td class="mono">$${esc(r.effectivePriceUsd)}</td>
        <td class="mono">${esc(r.priceImpactPct)}%</td>
        <td class="mono">${esc(r.routeFeePct)}%</td>
        <td class="mono">${esc(r.networkFeeSol)} + ${esc(r.priorityFeeSol)}</td>
        <td class="mono">${esc(r.minReceivedDisplay)}</td>
      </tr>`;

    container.innerHTML = `
      <button class="back" id="backBtn">← Back to opportunities</button>
      <div class="detail-head">
        <div class="opp-emoji">${esc(d.token.emoji)}</div>
        <div>
          <div class="row"><h2>${esc(d.token.symbol)}</h2><span class="muted">${esc(d.token.name)}</span>
            ${oppChip(sc.opportunityLabel)} ${riskChip(sc.riskLevel)}
            <button class="star ${d.inWatchlist ? "active" : ""}" id="watchStar">★</button>
          </div>
          <div class="tiny faint mono">${esc(d.token.mint)}</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div class="price mono">$${esc(d.market.priceUsd)}</div>
          <div class="small mono"><span class="${cls(d.market.change1hPct)}">${sign(d.market.change1hPct)}${esc(d.market.change1hPct)}% 1h</span>
            · <span class="${cls(d.market.change24hPct)}">${sign(d.market.change24hPct)}${esc(d.market.change24hPct)}% 24h</span></div>
        </div>
      </div>

      <div class="detail-grid">
        <div class="grid">
          <div class="card">
            <div class="row spread"><h3>Price — last 24h</h3><span class="tiny muted">${esc(d.dataSource)}</span></div>
            <div class="chart-wrap"><canvas class="spark" id="sparkCanvas"></canvas><div class="chart-tip" id="chartTip"></div></div>
          </div>

          <div class="card">
            <div class="row spread" style="flex-wrap:wrap;gap:10px">
              <h3>Execution routes</h3>
              <div class="row">
                <select id="routeSize" style="width:auto">${[1, 5, 10, 25].map((n) => `<option value="${n}" ${n === Number(size) ? "selected" : ""}>${n} SOL</option>`).join("")}</select>
                <span class="tiny muted">slippage ${esc(String((state.settings?.maxSlippageBps ?? 100) / 100))}%</span>
              </div>
            </div>
            <div class="table-scroll" style="margin-top:8px">
              <table class="routes-table">
                <thead><tr><th>Venue</th><th>Est. received</th><th>Eff. price</th><th>Impact</th><th>Pool fee</th><th>Network+priority (SOL)</th><th>Min received (slippage)</th></tr></thead>
                <tbody>
                  ${d.routes.best ? routeRow(d.routes.best, true) : ""}
                  ${d.routes.alternatives.map((r) => routeRow(r, false)).join("")}
                </tbody>
              </table>
            </div>
            ${d.routes.failures.length ? `<div class="tiny warn" style="margin-top:8px">⚠ ${d.routes.failures.map((f) => esc(f.message)).join(" · ")}</div>` : ""}
            ${d.roundTrip ? `<div class="tiny muted" style="margin-top:8px">Round trip now: buy ${esc(d.roundTrip.tokensOut)} ${esc(d.token.symbol)} → sell back ≈ <b class="mono">${esc(d.roundTrip.estimatedSellBackSol)} SOL</b> via ${esc(d.roundTrip.sellVenue)} (sell impact ${esc(d.roundTrip.sellImpactPct)}%). Round-trip costs are why instant flips lose money.</div>` : ""}
            <div class="tiny faint" style="margin-top:6px">Quotes are executable estimates for this exact size — not chart prices. Retrieved ${d.routes.best ? ago(d.routes.best.retrievedAtMs) : "—"}, expires ${d.routes.best ? Math.max(0, Math.round((d.routes.best.expiresAtMs - Date.now()) / 1000)) + "s" : "—"}.</div>
          </div>

          <div class="card">
            <h3>Market summary</h3>
            <div class="kv"><span class="k">Volume (1h)</span><span class="v mono">${usd(d.market.volume1hUsd)} (${sign(d.market.volumeChange1hPct)}${esc(d.market.volumeChange1hPct)}%)</span></div>
            <div class="kv"><span class="k">Buys per sell</span><span class="v mono">${esc(d.market.buySellRatio)}</span></div>
            <div class="kv"><span class="k">Transactions (1h)</span><span class="v mono">${d.market.txCount1h.toLocaleString()}</span></div>
            <div class="kv"><span class="k">Liquidity</span><span class="v mono">${usd(d.market.liquidityUsd)} (${sign(d.market.liquidityChange1hPct)}${esc(d.market.liquidityChange1hPct)}% 1h)</span></div>
            <div class="kv"><span class="k">Largest pool share</span><span class="v mono">${esc(d.market.topPoolSharePct)}%</span></div>
            <div class="kv"><span class="k">SOL reference price</span><span class="v mono">$${esc(d.market.solPriceUsd)}</span></div>
          </div>
        </div>

        <div class="grid">
          <div class="card">
            <h3 style="margin-bottom:10px">Why this ranks where it does</h3>
            ${scoreRow("Opportunity quality", sc.opportunity)}
            ${scoreRow("Market momentum", sc.momentum)}
            ${scoreRow("Liquidity quality", sc.liquidity)}
            ${scoreRow("Execution quality", sc.execution)}
            ${scoreRow("Token risk", sc.risk, true)}
            <div class="tiny faint" style="margin-top:8px">${esc(sc.disclaimer)}</div>
          </div>

          ${verificationCard(d)}

          <div class="card">
            <h3>Paper trade</h3>
            <div class="row" style="margin-top:10px">
              <div style="flex:1"><label class="field">AMOUNT (VIRTUAL SOL)</label><input type="number" id="tradeAmt" min="0.1" step="0.1" value="${esc(String(size))}"></div>
              <div style="flex:1"><label class="field">SLIPPAGE %</label><input type="number" id="tradeSlip" min="0.1" max="20" step="0.1" value="${esc(String((state.settings?.maxSlippageBps ?? 100) / 100))}"></div>
            </div>
            <button class="btn" id="tradeBtn" style="width:100%;margin-top:12px">Review paper trade</button>
            <div class="sim-notice">Simulated trade only — virtual SOL, no transaction, no real funds.</div>
          </div>
        </div>
      </div>
    `;

    container.querySelector("#backBtn").addEventListener("click", () => (location.hash = "#/"));
    container.querySelectorAll(".evidence-toggle").forEach((btn) =>
      btn.addEventListener("click", () => {
        // Look up relative to the button — the container node is detached
        // once render() moves the children into the live view.
        btn.closest(".score-row").querySelector("[data-evlist]").classList.toggle("hidden");
      }),
    );
    container.querySelector("#watchStar").addEventListener("click", async () => {
      try {
        const body = await post("/v1/watchlist", { mint: d.token.mint, watched: !d.inWatchlist });
        state.settings = body.settings;
        render();
      } catch (err) {
        toast(err.message, "error");
      }
    });
    container.querySelector("#routeSize").addEventListener("change", (e) => {
      state.filters.tradeSizeSol = Number(e.target.value);
      render();
    });
    container.querySelector("#tradeBtn").addEventListener("click", () => {
      const amt = parseFloat($("tradeAmt").value);
      const slip = parseFloat($("tradeSlip").value);
      if (!Number.isFinite(amt) || amt <= 0) return toast("Enter a positive SOL amount", "error");
      openTradeModal(d.token.mint, amt, Math.round(slip * 100));
    });

    // Chart needs layout sizes — run after the view is attached to the DOM
    return () => drawSpark($("sparkCanvas"), $("chartTip"), d.candles, d.token.symbol);
  }

  // ---------- price chart (single series, crosshair tooltip) ----------
  function drawSpark(canvas, tip, candles, symbol) {
    if (!canvas || !candles?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
    const h = 180;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const pad = { l: 8, r: 8, t: 12, b: 18 };
    const xs = candles.map((c) => c.t);
    const ys = candles.map((c) => c.price);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const yr = maxY - minY || maxY * 0.01 || 1;
    const X = (t) => pad.l + ((t - xs[0]) / (xs[xs.length - 1] - xs[0] || 1)) * (w - pad.l - pad.r);
    const Y = (p) => pad.t + (1 - (p - minY) / yr) * (h - pad.t - pad.b);

    // recessive grid: 3 horizontal lines
    ctx.strokeStyle = "rgba(42,49,64,0.6)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const y = pad.t + (i / 2) * (h - pad.t - pad.b);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
    }

    // area fill + 2px line in the single-series accent hue
    ctx.beginPath();
    candles.forEach((c, i) => (i === 0 ? ctx.moveTo(X(c.t), Y(c.price)) : ctx.lineTo(X(c.t), Y(c.price))));
    ctx.strokeStyle = "#7c5cff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(X(xs[xs.length - 1]), h - pad.b);
    ctx.lineTo(X(xs[0]), h - pad.b);
    ctx.closePath();
    ctx.fillStyle = "rgba(124,92,255,0.12)";
    ctx.fill();

    // min/max labels in ink, not series color
    ctx.fillStyle = "#8b93a7";
    ctx.font = "10px -apple-system, 'Segoe UI', sans-serif";
    const fmtP = (p) => (p >= 1 ? p.toFixed(3) : p >= 0.001 ? p.toFixed(5) : p.toFixed(8));
    ctx.fillText(`$${fmtP(maxY)}`, pad.l + 2, pad.t - 3);
    ctx.fillText(`$${fmtP(minY)}`, pad.l + 2, h - pad.b + 12);

    // crosshair + tooltip
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      let nearest = candles[0];
      let bd = Infinity;
      for (const c of candles) {
        const d = Math.abs(X(c.t) - mx);
        if (d < bd) {
          bd = d;
          nearest = c;
        }
      }
      const cx = X(nearest.t);
      const cy = Y(nearest.price);
      // redraw base then crosshair marker
      drawBase();
      ctx.strokeStyle = "rgba(139,147,167,0.5)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, pad.t);
      ctx.lineTo(cx, h - pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#7c5cff";
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#0d0f14";
      ctx.lineWidth = 2;
      ctx.stroke();

      tip.style.display = "block";
      tip.style.left = `${Math.min(cx + 10, w - 130)}px`;
      tip.style.top = `${Math.max(cy - 34, 2)}px`;
      const when = new Date(nearest.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      tip.innerHTML = `<b>${esc(symbol)}</b> $${fmtP(nearest.price)}<br><span class="muted">${when} · vol ${usd(nearest.volumeUsd)}</span>`;
    };
    canvas.onmouseleave = () => {
      tip.style.display = "none";
      drawBase();
    };

    const base = ctx.getImageData(0, 0, canvas.width, canvas.height);
    function drawBase() {
      ctx.putImageData(base, 0, 0);
    }
  }

  // ---------- Trade confirmation modal ----------
  async function openTradeModal(mint, amount, slippageBps) {
    const size = amount ?? state.filters.tradeSizeSol ?? 10;
    const slip = slippageBps ?? state.settings?.maxSlippageBps ?? 100;
    let d;
    try {
      d = await api(`/v1/tokens/${encodeURIComponent(mint)}?tradeSizeSol=${size}`);
    } catch (err) {
      return toast(err.message, "error");
    }
    const best = d.routes.best;
    if (!best) return toast("No executable route available for this size right now.", "error");
    const risks = d.scores.risk.factors.filter((f) => f.direction === "negative").slice(0, 3);
    const overLimit = parseFloat(best.priceImpactPct) * 100 > (state.settings?.maxPriceImpactBps ?? 100);

    showModal(`
      <h3>Confirm paper trade — ${esc(d.token.symbol)}</h3>
      <div class="tiny muted">Buy simulation via best route (${esc(best.venueName)}) · quote retrieved ${ago(best.retrievedAtMs)}</div>
      <div class="sim-notice">SIMULATED TRADE ONLY — virtual SOL will be spent. No transaction is sent, live execution is disabled, and market conditions may change before any real execution would be possible.</div>
      <div class="kv"><span class="k">Virtual SOL spent</span><span class="v mono">${esc(String(size))} SOL</span></div>
      <div class="kv"><span class="k">Estimated tokens received</span><span class="v mono">${esc(best.minReceivedDisplay)}</span></div>
      <div class="kv"><span class="k">Estimated entry price</span><span class="v mono">$${esc(best.effectivePriceUsd)}</span></div>
      <div class="kv"><span class="k">Pool fee</span><span class="v mono">${esc(best.routeFeePct)}%</span></div>
      <div class="kv"><span class="k">Network + priority fees</span><span class="v mono">${esc(best.networkFeeSol)} + ${esc(best.priorityFeeSol)} SOL</span></div>
      <div class="kv"><span class="k">Estimated price impact</span><span class="v mono ${overLimit ? "down" : ""}">${esc(best.priceImpactPct)}%${overLimit ? " (over your limit)" : ""}</span></div>
      <div class="kv"><span class="k">Slippage assumption</span><span class="v mono">${esc(String(slip / 100))}%</span></div>
      <div class="kv"><span class="k">Data timestamp</span><span class="v mono">${new Date(best.retrievedAtMs).toLocaleTimeString()}</span></div>
      ${risks.length ? `<div class="small" style="margin-top:10px"><b>Main risks:</b><ul class="evidence">${risks.map((r) => `<li class="fx negative">${esc(r.detail)}</li>`).join("")}</ul></div>` : ""}
      <div class="actions">
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn" id="confirmTrade">Open paper position</button>
      </div>
    `);

    $("confirmTrade").addEventListener("click", async () => {
      try {
        const body = await post("/v1/paper/positions", { tokenMint: mint, solAmount: Number(size), slippageBps: slip });
        closeModal();
        toast(`Simulated ${esc(d.token.symbol)} position opened — no real funds moved`, "ok");
        location.hash = "#/portfolio";
      } catch (err) {
        closeModal();
        toast(err.message, "error");
      }
    });
  }

  // ---------- Portfolio (persistent, USD paper account) ----------
  async function renderAccountPortfolio(container) {
    if (!session.authenticated) {
      container.innerHTML = signInPrompt("your paper portfolio");
      return wireSignInPrompt;
    }
    const { portfolio: p } = await api("/v1/me/portfolio");
    const money = (value) => (value === null ? "Unavailable" : `$${esc(value)}`);
    const pnl = (value) =>
      value === null ? "Unavailable" : `${num(value) > 0 ? "+" : ""}$${esc(value)}`;
    const positionCard = (position) => {
      const open = position.status === "open";
      const valueLabel = open ? "Live marked value" : "Exit proceeds";
      const value = open ? position.marketValueUsd : position.exit.proceedsUsd;
      const route = open ? position.valuation.route : position.exit.route;
      const impact = open ? position.valuation.priceImpactPct : position.exit.priceImpactPct;
      return `<div class="card pos-card live-paper-position" data-paper-id="${esc(position.id)}">
        <div class="pos-head">
          <span class="sym">${esc(position.token.symbol)}</span>
          <span class="chip ${open ? "live-chip" : ""}">${open ? "OPEN" : "CLOSED"} · LIVE-QUOTE PAPER</span>
          <span class="tiny faint">${open ? "opened" : "closed"} ${ago(open ? position.openedAtMs : position.closedAtMs)}</span>
          <span style="margin-left:auto" class="pnl mono ${position.pnlUsd === null ? "muted" : cls(position.pnlUsd)}">${pnl(position.pnlUsd)}${position.returnPct === null ? "" : ` <span class="small">(${sign(position.returnPct)}${esc(position.returnPct)}%)</span>`}</span>
        </div>
        <div class="mint-line mono" title="${esc(position.token.mint)}">${esc(position.token.mint)}</div>
        <div class="pos-grid">
          <div><div class="k">Cost basis</div><div class="v mono">$${esc(position.costBasisUsd)}</div></div>
          <div><div class="k">Quantity</div><div class="v mono">${esc(position.quantity)} ${esc(position.token.symbol)}</div></div>
          <div><div class="k">Entry price</div><div class="v mono">$${esc(position.entry.averagePriceUsd)}</div></div>
          <div><div class="k">Entry route</div><div class="v">${esc(position.entry.route.join(" → "))}</div></div>
          <div><div class="k">${valueLabel}</div><div class="v mono">${money(value)}</div></div>
          <div><div class="k">${open ? "Sell quote" : "Exit route"}</div><div class="v">${route ? esc(route.join(" → ")) : "Unavailable"}${impact === null ? "" : ` · ${esc(impact)}% impact`}</div></div>
        </div>
        <div class="tiny ${open && position.valuation.status !== "fresh" ? "warn" : "faint"}" style="margin-top:10px">${esc(open ? position.valuation.detail : "Closed using the stored minimum received from a fresh Jupiter sell quote.")}</div>
        <div class="row" style="justify-content:flex-end;margin-top:10px;flex-wrap:wrap">
          <button class="btn secondary paper-research">Research mint</button>
          ${open ? `<button class="btn danger live-paper-close">Close with live quote</button>` : ""}
        </div>
      </div>`;
    };
    const openPositions = p.positions.filter((position) => position.status === "open");
    const closedPositions = p.positions.filter((position) => position.status === "closed");
    container.innerHTML = `
      <div class="summary-strip">
        <div class="stat"><div class="k">PAPER CASH</div><div class="v mono">$${esc(p.cashUsd)}</div><div class="s">simulated USD</div></div>
        <div class="stat"><div class="k">INVESTED</div><div class="v mono">$${esc(p.investedUsd)}</div><div class="s">${p.openPositions} open positions</div></div>
        <div class="stat"><div class="k">TOTAL VALUE</div><div class="v mono">${money(p.totalValueUsd)}</div><div class="s">started at $${esc(p.startingCashUsd)}</div></div>
        <div class="stat"><div class="k">UNREALIZED P&amp;L</div><div class="v mono ${p.unrealizedPnlUsd === null ? "muted" : cls(p.unrealizedPnlUsd)}">${pnl(p.unrealizedPnlUsd)}</div><div class="s">minimum-received sell marks</div></div>
        <div class="stat"><div class="k">REALIZED P&amp;L</div><div class="v mono ${cls(p.realizedPnlUsd)}">${pnl(p.realizedPnlUsd)}</div><div class="s">${p.closedPositions} closed trades</div></div>
      </div>
      <div class="tiny warn" style="margin-bottom:16px">${esc(p.notice)}</div>

      <div class="card">
        <div class="row spread" style="flex-wrap:wrap;gap:8px">
          <h3>Live-quote paper positions</h3>
          <span class="tiny muted">${esc(p.limits.minEntryUsd)}–${esc(p.limits.maxEntryUsd)} USD per entry · max ${p.limits.maxOpenPositions} open</span>
        </div>
        ${p.positions.length ? "" : `<div class="empty" style="padding:26px 12px">No positions yet.<br><span class="tiny faint">Run an eligible production check on a live token, then choose Paper buy.</span></div>`}
      </div>

      ${openPositions.length ? `<h3 style="margin:16px 0 10px">Open positions</h3><div>${openPositions.map(positionCard).join("")}</div>` : ""}
      ${closedPositions.length ? `<h3 style="margin:16px 0 10px">Closed positions</h3><div>${closedPositions.map(positionCard).join("")}</div>` : ""}

      <div class="card" style="margin-top:14px">
        <h3>Account</h3>
        <div class="kv"><span class="k">Signed in as</span><span class="v">${esc(session.user.email)}</span></div>
        <div class="kv"><span class="k">Base currency</span><span class="v">${esc(p.baseCurrency)}</span></div>
        <div class="kv"><span class="k">Opened</span><span class="v">${new Date(p.createdAtMs).toLocaleDateString()}</span></div>
        <div class="tiny faint" style="margin-top:10px">Cash and positions are stored in Moonpaper's database. Market values are requested live and become unavailable rather than falling back to invented prices.</div>
      </div>`;

    container.querySelectorAll(".live-paper-position").forEach((card) => {
      const position = p.positions.find((item) => item.id === card.dataset.paperId);
      card.querySelector(".paper-research").addEventListener("click", () => {
        location.hash = `#/research/${position.token.mint}`;
      });
      const close = card.querySelector(".live-paper-close");
      if (close) close.addEventListener("click", () => openLivePaperCloseModal(position));
    });
  }

  // ---------- Watchlist ----------
  async function renderWatchlist(container) {
    if (!session.authenticated) {
      container.innerHTML = signInPrompt("your watchlist");
      return wireSignInPrompt;
    }
    const list = await api("/v1/me/watchlist");
    if (list.count === 0) {
      container.innerHTML = `<h2>Watchlist</h2><div class="empty">Nothing saved yet.<br><span class="tiny faint">Research any token and press Watch to keep an eye on it.</span></div>`;
      return;
    }
    container.innerHTML = `
      <h2>Watchlist <span class="tiny muted">${list.count} token${list.count === 1 ? "" : "s"} · live data fetched on open</span></h2>
      <div id="wlList"></div>`;

    // Only the mint is stored, so identity and market data are resolved live
    // rather than served from a stale copy in our database.
    const holder = container.querySelector("#wlList");
    for (const item of list.items) {
      const row = document.createElement("div");
      row.className = "opp-card";
      row.innerHTML = `<div class="opp-main"><div class="opp-title"><span class="sym mono">${esc(item.tokenMint.slice(0, 8))}…</span><span class="muted small">loading live data…</span></div></div>`;
      holder.appendChild(row);
      api(`/v1/research/${encodeURIComponent(item.tokenMint)}`)
        .then((d) => {
          row.innerHTML = `
            <div class="opp-main">
              <div class="opp-title">
                <span class="sym">${esc(d.symbol)}</span>
                <span class="muted small">${esc(d.name)}</span>
                <span class="chip risk-${esc(d.risk.level)}">RISK: ${esc(d.risk.level.toUpperCase())}</span>
                ${d.verification.status === "verified" ? `<span class="chip live-chip">✓ ON-CHAIN</span>` : `<span class="chip unver-chip">UNVERIFIED</span>`}
              </div>
              <div class="opp-metrics mono">
                <span>Price <b>${d.market.priceUsd ? "$" + esc(d.market.priceUsd) : "—"}</b></span>
                <span>24h <b class="${cls(d.market.change24hPct ?? 0)}">${d.market.change24hPct !== null ? sign(d.market.change24hPct) + esc(d.market.change24hPct) + "%" : "—"}</b></span>
                <span>Liquidity <b>${d.market.liquidityUsd ? usd(d.market.liquidityUsd) : "—"}</b></span>
              </div>
            </div>
            <div class="opp-side">
              <button class="btn secondary wl-open">Research</button>
              <button class="btn danger wl-remove">Remove</button>
            </div>`;
          row.querySelector(".wl-open").addEventListener("click", () => (location.hash = `#/research/${item.tokenMint}`));
          row.querySelector(".wl-remove").addEventListener("click", async () => {
            await api(`/v1/me/watchlist/${encodeURIComponent(item.tokenMint)}`, { method: "DELETE" });
            toast("Removed from watchlist");
            render();
          });
        })
        .catch(() => {
          row.innerHTML = `<div class="opp-main"><div class="opp-title"><span class="sym mono">${esc(item.tokenMint.slice(0, 8))}…</span><span class="warn small">live data unavailable</span></div></div>`;
        });
    }
  }

  // ---------- Simulator portfolio (demo, SOL-denominated) ----------
  async function renderPortfolio(container) {
    const p = await api("/v1/paper/portfolio");
    const s = p.stats;
    const rl = (l) => s.byRiskLevel[l] || { trades: 0, realizedPnlSol: "0.0000", winRatePct: 0 };

    const posCard = (pos, open) => {
      const pnl = open ? pos.unrealizedPnlSol : pos.realizedPnlSol;
      return `
      <div class="card pos-card" data-pos="${esc(pos.id)}">
        <div class="pos-head">
          <span class="sym">${esc(pos.tokenSymbol)}</span>
          <span class="chip">${open ? "OPEN" : "CLOSED"} · PAPER</span>
          ${riskChip(pos.entryConditions.riskLevel)}
          ${pos.valuationStale ? `<span class="chip" style="color:var(--orange)">VALUE STALE ⚠</span>` : ""}
          <span class="tiny faint">opened ${ago(pos.openedAtMs)}${open ? "" : ` · closed ${ago(pos.closedAtMs)}`}</span>
          <span style="margin-left:auto" class="pnl mono ${cls(pnl)}">${sign(pnl)}${esc(pnl)} SOL <span class="small">(${sign(pos.returnPct)}${esc(pos.returnPct)}%)</span></span>
        </div>
        <div class="pos-grid">
          <div><div class="k">Size</div><div class="v mono">${esc(pos.solSpent)} SOL</div></div>
          <div><div class="k">Tokens</div><div class="v mono">${esc(pos.tokensReceived)}</div></div>
          <div><div class="k">Entry price</div><div class="v mono">$${esc(pos.entryPriceUsd)}</div></div>
          <div><div class="k">Entry route</div><div class="v">${esc(pos.entryVenue)} (impact ${esc(pos.entryImpactPct)}%)</div></div>
          <div><div class="k">${open ? "Current value" : "Exit value"}</div><div class="v mono">${esc(open ? pos.currentValueSol : pos.exitValueSol)} SOL</div></div>
          <div><div class="k">Fees paid</div><div class="v mono">${esc(pos.entryFeesSol)}${pos.exitFeesSol ? " + " + esc(pos.exitFeesSol) : ""} SOL</div></div>
          <div><div class="k">High / low</div><div class="v mono">${esc(pos.highWaterSol)} / ${esc(pos.lowWaterSol)}</div></div>
          <div><div class="k">Entry quality</div><div class="v">${pos.entryConditions.opportunityScore}/100 · ${esc(pos.entryConditions.riskLevel)} risk</div></div>
          ${open ? "" : `<div><div class="k">Exit route</div><div class="v">${esc(pos.exitVenue ?? "—")} (impact ${esc(pos.exitImpactPct ?? "—")}%)</div></div>`}
        </div>
        ${open ? `<div class="row" style="margin-top:12px"><button class="btn danger close-btn">Close paper position</button><span class="tiny faint">Closed at the current executable sell quote incl. impact, fees, and slippage — never the chart price.</span></div>` : ""}
      </div>`;
    };

    container.innerHTML = `
      <div class="summary-strip">
        <div class="stat"><div class="k">STARTING BALANCE</div><div class="v mono">${esc(p.startingBalanceSol)} SOL</div><div class="s">virtual</div></div>
        <div class="stat"><div class="k">AVAILABLE CASH</div><div class="v mono">${esc(p.cashSol)} SOL</div><div class="s">virtual</div></div>
        <div class="stat"><div class="k">TOTAL VALUE</div><div class="v mono">${esc(p.totalValueSol)} SOL</div><div class="s">cash + open positions</div></div>
        <div class="stat"><div class="k">REALIZED P&amp;L</div><div class="v mono ${cls(s.totalRealizedPnlSol)}">${sign(s.totalRealizedPnlSol)}${esc(s.totalRealizedPnlSol)} SOL</div><div class="s">${s.closedCount} closed</div></div>
        <div class="stat"><div class="k">UNREALIZED P&amp;L</div><div class="v mono ${cls(s.totalUnrealizedPnlSol)}">${sign(s.totalUnrealizedPnlSol)}${esc(s.totalUnrealizedPnlSol)} SOL</div><div class="s">${s.openCount} open</div></div>
      </div>
      <div class="tiny warn" style="margin-bottom:14px">All values are simulated paper-trading results — no real funds are involved.</div>

      <h2>Open positions</h2>
      <div id="openList">${p.openPositions.length ? p.openPositions.map((x) => posCard(x, true)).join("") : `<div class="empty">No open paper positions. Find an opportunity on the Discover tab.</div>`}</div>

      <h2 style="margin-top:20px">Performance <span class="tiny muted">(simulated)</span></h2>
      <div class="card">
        <div class="pos-grid">
          <div><div class="k">Win rate</div><div class="v mono">${s.closedCount ? s.winRatePct + "%" : "—"} (${s.winCount}W / ${s.lossCount}L)</div></div>
          <div><div class="k">Avg gain</div><div class="v mono up">${esc(s.avgGainPct)}%</div></div>
          <div><div class="k">Avg loss</div><div class="v mono down">${esc(s.avgLossPct)}%</div></div>
          <div><div class="k">Best trade</div><div class="v mono">${sign(s.bestTradePct)}${esc(s.bestTradePct)}%</div></div>
          <div><div class="k">Worst trade</div><div class="v mono">${sign(s.worstTradePct)}${esc(s.worstTradePct)}%</div></div>
          <div><div class="k">Network fees paid</div><div class="v mono">${esc(s.totalNetworkFeesSol)} SOL</div></div>
          <div><div class="k">Avg execution cost</div><div class="v mono">${esc(s.avgExecutionCostPct)}% (fees + impact)</div></div>
        </div>
        <h3 style="margin-top:14px">By risk level at entry</h3>
        <div class="table-scroll"><table class="routes-table" style="margin-top:6px">
          <thead><tr><th>Risk level</th><th>Closed trades</th><th>Realized P&amp;L</th><th>Win rate</th></tr></thead>
          <tbody>
            ${["low", "medium", "high"].map((l) => `<tr><td>${l}</td><td class="mono">${rl(l).trades}</td><td class="mono ${cls(rl(l).realizedPnlSol)}">${sign(rl(l).realizedPnlSol)}${esc(rl(l).realizedPnlSol)} SOL</td><td class="mono">${rl(l).trades ? rl(l).winRatePct + "%" : "—"}</td></tr>`).join("")}
          </tbody>
        </table></div>
      </div>

      <h2 style="margin-top:20px">Closed positions</h2>
      <div>${p.closedPositions.length ? p.closedPositions.map((x) => posCard(x, false)).join("") : `<div class="empty">No closed paper trades yet.</div>`}</div>
    `;

    container.querySelectorAll(".close-btn").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = btn.closest("[data-pos]").dataset.pos;
        const pos = p.openPositions.find((x) => x.id === id);
        showModal(`
          <h3>Close paper position — ${esc(pos.tokenSymbol)}</h3>
          <div class="sim-notice">Simulated close — the exit uses the current executable sell quote including price impact, pool fees, network fees, and your slippage assumption.</div>
          <div class="kv"><span class="k">Current value</span><span class="v mono">${esc(pos.currentValueSol)} SOL</span></div>
          <div class="kv"><span class="k">Unrealized P&amp;L</span><span class="v mono ${cls(pos.unrealizedPnlSol)}">${sign(pos.unrealizedPnlSol)}${esc(pos.unrealizedPnlSol)} SOL (${sign(pos.returnPct)}${esc(pos.returnPct)}%)</span></div>
          <div class="actions">
            <button class="btn secondary" data-close>Keep position</button>
            <button class="btn danger" id="confirmClose">Close position</button>
          </div>
        `);
        $("confirmClose").addEventListener("click", async () => {
          try {
            const body = await post(`/v1/paper/positions/${id}/close`);
            closeModal();
            const r = body.position.realizedPnlSol;
            toast(`Closed ${esc(pos.tokenSymbol)}: ${sign(r)}${r} SOL (simulated)`, num(r) >= 0 ? "ok" : "");
            render();
          } catch (err) {
            closeModal();
            toast(err.message, "error");
          }
        });
      }),
    );
  }

  // ---------- Settings ----------
  async function renderSettings(container) {
    const st = state.settings;
    const notif = st.notifications;
    container.innerHTML = `
      <h2>Settings</h2>
      <div class="tiny muted" style="margin-bottom:14px">Defaults are ready to use — nothing here is required before paper trading.</div>
      <div class="detail-grid">
        <div class="card">
          <h3 style="margin-bottom:10px">Strategy</h3>
          <label class="field">TYPICAL PAPER-TRADE SIZE (SOL)</label>
          <input type="number" id="sSize" min="0.1" step="0.5" value="${st.defaultTradeSizeSol}">
          <label class="field" style="margin-top:10px">RISK PREFERENCE</label>
          <select id="sRisk">
            ${["conservative", "balanced", "aggressive"].map((r) => `<option value="${r}" ${st.riskPreference === r ? "selected" : ""}>${r[0].toUpperCase() + r.slice(1)}</option>`).join("")}
          </select>
          <label class="field" style="margin-top:10px">MAX PRICE IMPACT (%)</label>
          <input type="number" id="sImpact" min="0.05" max="50" step="0.05" value="${st.maxPriceImpactBps / 100}">
          <label class="field" style="margin-top:10px">MAX SLIPPAGE (%)</label>
          <input type="number" id="sSlip" min="0.05" max="20" step="0.05" value="${st.maxSlippageBps / 100}">
          <label class="field" style="margin-top:10px">MIN TOKEN LIQUIDITY (USD)</label>
          <input type="number" id="sLiq" min="0" step="10000" value="${st.minLiquidityUsd}">
          <label class="field" style="margin-top:10px">MIN TOKEN AGE (DAYS)</label>
          <input type="number" id="sAge" min="0" step="1" value="${st.minTokenAgeDays}">
          <label class="field" style="margin-top:10px">MIN OPPORTUNITY SCORE (0–100)</label>
          <input type="number" id="sScore" min="0" max="100" step="5" value="${st.minOpportunityScore}">
        </div>
        <div class="card">
          <h3 style="margin-bottom:10px">Alerts</h3>
          <label class="field">ALERT WHEN A PAPER POSITION GAINS (%)</label>
          <input type="number" id="sGain" min="1" step="1" value="${st.positionAlertGainPct}">
          <label class="field" style="margin-top:10px">ALERT WHEN A PAPER POSITION LOSES (%)</label>
          <input type="number" id="sLoss" min="1" step="1" value="${st.positionAlertLossPct}">
          <h3 style="margin:16px 0 6px">Notification categories</h3>
          ${[
            ["opportunityMatch", "Opportunity matches my settings"],
            ["scoreChange", "Opportunity score changed materially"],
            ["liquidityDrop", "Liquidity dropped sharply"],
            ["riskIncrease", "Risk level increased"],
            ["betterRoute", "Better execution route available"],
            ["positionThreshold", "Paper position hit gain/loss threshold"],
          ]
            .map(
              ([key, label]) => `
            <label class="row small" style="padding:5px 0;cursor:pointer">
              <input type="checkbox" data-notif="${key}" ${notif[key] ? "checked" : ""} style="width:auto"> ${label}
            </label>`,
            )
            .join("")}
          <button class="btn" id="saveSettings" style="width:100%;margin-top:16px">Save settings</button>
          <div class="tiny faint" style="margin-top:8px">Alerts are in-app only and always explain why they fired. They never claim a token will rise.</div>
        </div>
      </div>
    `;

    container.querySelector("#saveSettings").addEventListener("click", async () => {
      try {
        const patch = {
          defaultTradeSizeSol: parseFloat($("sSize").value),
          riskPreference: $("sRisk").value,
          maxPriceImpactBps: Math.round(parseFloat($("sImpact").value) * 100),
          maxSlippageBps: Math.round(parseFloat($("sSlip").value) * 100),
          minLiquidityUsd: Math.round(parseFloat($("sLiq").value)),
          minTokenAgeDays: Math.round(parseFloat($("sAge").value)),
          minOpportunityScore: Math.round(parseFloat($("sScore").value)),
          positionAlertGainPct: parseFloat($("sGain").value),
          positionAlertLossPct: parseFloat($("sLoss").value),
          notifications: Object.fromEntries(
            [...document.querySelectorAll("[data-notif]")].map((cb) => [cb.dataset.notif, cb.checked]),
          ),
        };
        const body = await put("/v1/settings", patch);
        state.settings = body.settings;
        toast("Settings saved", "ok");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  // ---------- notifications drawer ----------
  async function refreshNotifications() {
    // Never fetch while the backend is known-unhealthy: the poll loop owns
    // recovery, and this must not become a second, unbounded retry path.
    if (poll.failures > 0) return;
    try {
      const body = await api("/v1/notifications");
      const badge = $("notifBadge");
      if (body.unread > 0) {
        badge.textContent = body.unread > 9 ? "9+" : String(body.unread);
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
      $("notifList").innerHTML = body.notifications.length
        ? body.notifications
            .map(
              (n) => `
        <div class="notif ${n.read ? "read" : ""}">
          <div class="t"><span class="dot"></span>${esc(n.title)}</div>
          <div class="r">${esc(n.reason)}</div>
          <div class="when">${ago(n.createdAtMs)} · ${esc(n.category.replace(/_/g, " "))}</div>
        </div>`,
            )
            .join("")
        : `<div class="empty">No alerts yet. Alerts appear when market conditions match your settings.</div>`;
    } catch {
      /* backend down — banner state handled elsewhere */
    }
  }

  $("notifBtn").addEventListener("click", () => {
    $("drawer").classList.add("open");
    refreshNotifications();
  });
  $("drawerClose").addEventListener("click", () => $("drawer").classList.remove("open"));
  $("markReadBtn").addEventListener("click", async () => {
    await post("/v1/notifications/mark-read");
    refreshNotifications();
  });

  // ---------- modal plumbing ----------
  function showModal(html) {
    state.modalOpen = true;
    $("modalRoot").innerHTML = `<div class="overlay" id="overlay"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    $("overlay").addEventListener("click", (e) => {
      if (e.target.id === "overlay") closeModal();
    });
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  }
  function closeModal() {
    state.modalOpen = false;
    $("modalRoot").innerHTML = "";
  }

  // ---------- render root ----------
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    setActiveTab();
    const container = $("view");
    if (!container.dataset.loaded) {
      container.innerHTML = `<div class="loading-block"><div class="spinner"></div>Loading market data…</div>`;
    }
    try {
      if (!state.settings) await loadSettings();
      const target = document.createElement("div");
      let after = null;
      if (state.route.name === "research") after = await renderResearch(target, state.route.mint);
      else if (state.route.name === "token") after = await renderToken(target, state.route.mint);
      else if (state.route.name === "portfolio") after = await renderAccountPortfolio(target);
      else if (state.route.name === "watchlist") after = await renderWatchlist(target);
      else if (state.route.name === "simulator") after = await renderPortfolio(target);
      else if (state.route.name === "settings") after = await renderSettings(target);
      else after = await renderDiscover(target);
      if (seq !== renderSeq) return; // a newer render superseded this one
      container.innerHTML = "";
      container.append(...target.children);
      container.dataset.loaded = "1";
      if (typeof after === "function") after();
    } catch (err) {
      if (seq !== renderSeq) return;
      container.innerHTML = `<div class="empty">⚠ ${esc(err.message)}<br><br><button class="btn secondary" onclick="location.reload()">Retry</button></div>`;
    }
  }

  // ---------- health-aware polling ----------
  // A failing backend must not be hammered. Consecutive failures back off
  // exponentially and recover immediately on the first success, so an outage
  // produces a handful of requests rather than one every 15 seconds forever.
  const BASE_POLL_MS = 15_000;
  const MAX_POLL_MS = 300_000; // 5 minutes
  const poll = { failures: 0, timer: null, stopped: false };

  function nextDelayMs() {
    if (poll.failures === 0) return BASE_POLL_MS;
    return Math.min(BASE_POLL_MS * 2 ** poll.failures, MAX_POLL_MS);
  }

  function setBanner(text, unhealthy) {
    const el = $("dataBanner");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("banner-error", Boolean(unhealthy));
  }

  /** Single source of truth for "is the backend usable right now?". */
  async function checkHealth() {
    try {
      const h = await api("/health");
      poll.failures = 0;
      if (h.degraded) {
        setBanner(
          h.database === "schema_missing"
            ? "Account services unavailable — the database is not initialized. Research and quotes still work."
            : "Account services are temporarily unavailable. Research and quotes still work.",
          true,
        );
      } else {
        setBanner(
          `LIVE SOLANA RESEARCH — ${h.liveFeedSource || "Jupiter"} · paper trading only · live execution disabled`,
          false,
        );
      }
      return true;
    } catch (err) {
      poll.failures++;
      setBanner(
        err.status >= 500
          ? "Moonpaper's server is having trouble. Retrying automatically…"
          : UNREACHABLE(),
        true,
      );
      return false;
    }
  }

  function scheduleNextPoll() {
    if (poll.stopped) return;
    clearTimeout(poll.timer);
    poll.timer = setTimeout(runPollCycle, nextDelayMs());
  }

  async function runPollCycle() {
    const healthy = await checkHealth();
    // Only do further work when the backend can actually serve it. This is
    // what stops a dead backend from generating a request storm.
    if (healthy) {
      const el = document.activeElement;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
      const busy =
        state.modalOpen || typing || search.open || state.route.name === "settings" || state.route.name === "research";
      if (!busy) render();
      refreshNotifications();
    }
    scheduleNextPoll();
  }

  // Retry promptly when the user returns to the tab or regains connectivity,
  // instead of waiting out a long backoff.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && poll.failures > 0) {
      poll.failures = 0;
      scheduleNextPoll();
    }
  });
  window.addEventListener("online", () => {
    poll.failures = 0;
    scheduleNextPoll();
  });

  checkHealth().then(scheduleNextPoll);

  state.route = parseHash();
  // Session first: the rest of the UI depends on knowing who is asking.
  loadSession().then(render);
  refreshNotifications();
})();
