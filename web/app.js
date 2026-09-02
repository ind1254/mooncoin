/* Moonpaper — live Solana research, paper tools, and key-free FOMO handoff. */
(() => {
  "use strict";

  // ---------- tiny helpers ----------
  // FOMO's verified universal link maps this numeric chain identifier to
  // Solana, then opens the immutable mint's token screen in its app or web UI.
  // Moonpaper never passes an amount, side, wallet, or signing material.
  const FOMO_COIN_URL = "https://fomo.family/coin";
  const FOMO_SOLANA_CHAIN_ID = "1399811149";
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
  const fomoCoinUrl = (mint) => {
    const url = new URL(FOMO_COIN_URL);
    url.searchParams.set("address", String(mint).trim());
    url.searchParams.set("chainId", FOMO_SOLANA_CHAIN_ID);
    return url.toString();
  };

  function toast(message, kind = "") {
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.textContent = message;
    $("toasts").appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  // Dynamic provider images are optional decoration. Remove failed images via
  // a delegated listener so the main page can keep a strict script-src CSP
  // without inline onerror handlers.
  document.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement && target.dataset.removeOnError === "true") target.remove();
    },
    true,
  );

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
    } catch (error) {
      if (error?.name === "AbortError") throw error;
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
    filters: {
      search: "",
      risk: "",
      minLiquidityUsd: "",
      minMarketCapUsd: "",
      marketAge: "",
      minVolume5mUsd: "5000",
      minQualityScore: "70",
      maxRiskScore: "45",
      sort: "score",
      tradeSizeSol: null,
      feedKind: "trending",
    },
    gateReports: new Map(),
    portfolioRequestIds: new Map(),
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
    if (h.startsWith("verify-email/")) return { name: "verify-email", token: h.slice(13) };
    if (h.startsWith("reset-password/")) return { name: "reset-password", token: h.slice(15) };
    if (h.startsWith("research/")) return { name: "research", mint: h.slice(9) };
    if (h.startsWith("token/")) return { name: "token", mint: h.slice(6) };
    if (h === "portfolio" || h === "bot" || h === "settings" || h === "watchlist" || h === "simulator") return { name: h };
    return { name: "discover" };
  }

  // ---------- session ----------
  // The browser never asserts identity. It asks the server who it is, and the
  // server answers from the httpOnly session cookie the page cannot read.
  const session = {
    loading: true,
    authenticated: false,
    user: null,
    accountsEnabled: true,
    ownerMode: false,
    emailVerificationRequired: false,
    emailDeliveryConfigured: false,
  };

  async function loadSession() {
    try {
      const body = await api("/v1/me");
      session.authenticated = body.authenticated;
      session.user = body.user;
      session.accountsEnabled = body.accountsEnabled !== false;
      session.ownerMode = body.ownerMode === true;
      session.emailVerificationRequired = body.emailVerificationRequired === true;
      session.emailDeliveryConfigured = body.emailDeliveryConfigured === true;
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
           ${session.emailVerificationRequired && session.user.emailVerified === false ? `<button class="verify-pill" id="resendVerifyBtn" title="Send a new verification email">verify email</button>` : ""}
           <button class="linkbtn" id="signOutBtn">${session.ownerMode ? "Lock" : "Sign out"}</button>
         </div>`
      : `<button class="btn" id="signInBtn" style="padding:7px 14px;font-size:13px">${session.ownerMode ? "Owner access" : "Sign in"}</button>`;

    const signIn = $("signInBtn");
    if (signIn) signIn.addEventListener("click", openAccessModal);
    const signOut = $("signOutBtn");
    const resend = $("resendVerifyBtn");
    if (resend) resend.addEventListener("click", resendVerification);
    if (signOut)
      signOut.addEventListener("click", async () => {
        await post("/v1/auth/signout").catch(() => undefined);
        session.authenticated = false;
        session.user = null;
        renderAccountArea();
        toast(session.ownerMode ? "Moonpaper locked" : "Signed out");
        render();
      });
  }

  function openAccessModal() {
    if (session.ownerMode) return openOwnerAccessModal();
    openAuthModal("signin");
  }

  /**
   * The owner key is sent once and exchanged for an httpOnly session cookie.
   * It is never written to localStorage, sessionStorage, a URL, or the DOM
   * after the request completes.
   */
  function openOwnerAccessModal() {
    showModal(`
      <h3>Unlock Moonpaper</h3>
      <div class="tiny muted" style="margin-top:4px">This deployment has one owner. Enter your private owner key to open Bot Lab, portfolio, and watchlist.</div>
      <div id="ownerAccessErr" class="error-box hidden"></div>
      <label class="field" style="margin-top:12px">OWNER ACCESS KEY</label>
      <input type="password" id="ownerAccessKey" autocomplete="current-password" spellcheck="false" placeholder="Paste your private key">
      <div class="actions">
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn" id="ownerAccessSubmit">Unlock</button>
      </div>
      <div class="sim-notice">The key unlocks paper-trading controls only. Moonpaper still cannot build, sign, or submit a real transaction.</div>
    `);

    const submit = async () => {
      const keyInput = $("ownerAccessKey");
      const key = keyInput.value;
      const error = $("ownerAccessErr");
      const button = $("ownerAccessSubmit");
      error.classList.add("hidden");
      button.disabled = true;
      button.textContent = "Unlocking…";
      try {
        const body = await api("/v1/owner/unlock", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
        });
        keyInput.value = "";
        session.authenticated = true;
        session.user = body.user;
        closeModal();
        renderAccountArea();
        toast("Owner access unlocked", "ok");
        render();
      } catch (e) {
        keyInput.value = "";
        error.textContent = e.message;
        error.classList.remove("hidden");
        button.disabled = false;
        button.textContent = "Unlock";
        keyInput.focus();
      }
    };

    $("ownerAccessSubmit").addEventListener("click", submit);
    $("ownerAccessKey").addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    $("ownerAccessKey").focus();
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
      ${isSignUp ? "" : `<div class="tiny faint" style="margin-top:8px;text-align:center"><button class="linkbtn" id="forgotPassword">Forgot password?</button></div>`}
      <div class="sim-notice">Moonpaper is paper trading only. It never connects a wallet, requests keys, or moves real assets.</div>
    `);

    $("authSwap").addEventListener("click", () => openAuthModal(isSignUp ? "signin" : "signup"));
    const forgot = $("forgotPassword");
    if (forgot) forgot.addEventListener("click", () => openForgotPasswordModal($("authEmail").value.trim()));

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
        toast(
          isSignUp && body.verificationRequired
            ? body.verificationEmailSent
              ? "Account created — check your email to enable paper actions"
              : "Account created — use Verify email to request a new link"
            : isSignUp
              ? "Account created — $100,000 paper capital ready"
              : "Signed in",
          "ok",
        );
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

  function openForgotPasswordModal(initialEmail = "") {
    showModal(`
      <h3>Reset your password</h3>
      <div class="tiny muted" style="margin-top:4px">Enter your account email. For privacy, Moonpaper always gives the same response.</div>
      <div id="recoveryMsg" class="error-box hidden"></div>
      <label class="field" style="margin-top:12px">EMAIL</label>
      <input type="text" id="recoveryEmail" autocomplete="email" value="${esc(initialEmail)}" placeholder="you@example.com">
      <div class="actions">
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn" id="recoverySubmit">Send reset link</button>
      </div>
    `);
    const submit = async () => {
      const button = $("recoverySubmit");
      const message = $("recoveryMsg");
      button.disabled = true;
      button.textContent = "Sending…";
      try {
        const body = await post("/v1/auth/forgot-password", { email: $("recoveryEmail").value.trim() });
        message.textContent = body.message;
        message.classList.remove("hidden");
        message.classList.add("success-box");
        button.textContent = "Sent";
      } catch (error) {
        message.textContent = error.message;
        message.classList.remove("hidden");
        button.disabled = false;
        button.textContent = "Send reset link";
      }
    };
    $("recoverySubmit").addEventListener("click", submit);
    $("recoveryEmail").addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    $("recoveryEmail").focus();
  }

  async function resendVerification() {
    const button = $("resendVerifyBtn");
    if (button) button.disabled = true;
    try {
      const body = await post("/v1/auth/resend-verification");
      toast(body.alreadyVerified ? "Email is already verified" : "Verification email sent", "ok");
      if (body.alreadyVerified) await loadSession();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  /** Shown wherever a personal feature needs an account. */
  function signInPrompt(what) {
    if (session.ownerMode) {
      return `
        <div class="empty">
          <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px">Unlock ${esc(what)}</div>
          <div style="max-width:420px;margin:0 auto 14px">This is your private Moonpaper deployment. Use the owner key once; the browser keeps only a secure session cookie.</div>
          <button class="btn" id="promptSignIn">Owner access</button>
        </div>`;
    }
    return `
      <div class="empty">
        <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px">Sign in to use ${esc(what)}</div>
        <div style="max-width:420px;margin:0 auto 14px">Research, risk analysis and live quotes stay free and open to everyone. This part is personal to you, so it needs an account.</div>
        <button class="btn" id="promptSignIn">Create an account</button>
      </div>`;
  }

  function wireSignInPrompt() {
    const b = $("promptSignIn");
    if (b) b.addEventListener("click", openAccessModal);
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
      const target = ["token", "research", "verify-email", "reset-password"].includes(state.route.name)
        ? "discover"
        : state.route.name;
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
    "solana-rpc:mainnet": { label: "Solana RPC", live: true, hint: "Read directly from Solana mainnet — the token's mint account, and the token accounts of its largest holders." },
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
    if (!session.authenticated) return openAccessModal();
    if (!livePaperReportIsUsable(report)) {
      return toast("Run a fresh eligible production check before reviewing this paper entry.", "error");
    }
    // Reused by every retry from this modal. The server binds it to the first
    // recorded position, so a lost response can never spend paper cash twice.
    const clientRequestId = crypto.randomUUID();
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
          clientRequestId,
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
        <div class="hero-note">Research and paper tools stay key-free. “Trade on FOMO” opens the selected mint in FOMO, where you review and authorize any real transaction.</div>
      </section>`;
  }

  function resultRowHtml(r, i) {
    const price = r.priceUsd ? `$${esc(r.priceUsd)}` : "—";
    const liq = r.liquidityUsd ? usd(r.liquidityUsd) : "—";
    return `
      <div class="sresult ${i === search.active ? "active" : ""}" role="option" data-mint="${esc(r.mint)}" data-i="${i}" aria-selected="${i === search.active}" tabindex="-1">
        <div class="sresult-icon">${r.iconUrl ? `<img src="${esc(r.iconUrl)}" alt="" loading="lazy" data-remove-on-error="true">` : "◎"}</div>
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
  function liveFeedParams() {
    const params = new URLSearchParams({
      kind: state.filters.feedKind,
      limit: "60",
      sort: state.filters.sort || "score",
    });
    for (const key of ["minLiquidityUsd", "minMarketCapUsd", "minVolume5mUsd", "minQualityScore", "maxRiskScore"]) {
      if (state.filters[key]) params.set(key, state.filters[key]);
    }
    if (state.filters.search) params.set("search", state.filters.search);
    if (state.filters.marketAge === "new24h") params.set("maxAgeMinutes", "1440");
    if (state.filters.marketAge === "age1h") params.set("minAgeMinutes", "60");
    if (state.filters.marketAge === "age1d") params.set("minAgeMinutes", "1440");
    if (state.filters.marketAge === "age7d") params.set("minAgeMinutes", "10080");
    // Established coins live on the auto-watch shelf so Discover stays about
    // tokens the user has not seen yet. This reveals them on demand.
    if (state.filters.includeGraduated) params.set("includeGraduated", "true");
    return params;
  }

  async function renderDiscover(container) {
    const params = liveFeedParams();

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
          <div class="eyebrow">ACTIONABLE SOLANA SIGNALS</div>
          <h2>${state.filters.feedKind === "recent" ? "New pools, confidence ranked" : "Five-minute trending, confidence first"}</h2>
          <p class="muted small">${esc(feed.notice)}</p>
        </div>
        <div class="feed-pulse ${feed.reliability !== "fresh" ? "stale" : ""}"><i></i><span class="live-age">${feed.reliability === "fresh" ? "LIVE" : "DELAYED"} · source age ${(feed.ageMilliseconds / 1000).toFixed(1)}s</span></div>
      </div>

      <div class="feed-tabs" role="tablist" aria-label="Live token feed">
        <button class="${state.filters.feedKind === "trending" ? "active" : ""}" data-feed="trending" role="tab">Trending 5m</button>
        <button class="${state.filters.feedKind === "recent" ? "active" : ""}" data-feed="recent" role="tab">Newest</button>
      </div>

      <div class="filters live-filters">
        <div class="search"><label class="field">FILTER THIS FEED</label><input type="text" id="fSearch" placeholder="Token, name, or mint…" value="${esc(state.filters.search)}"></div>
        <div><label class="field">MIN LIVE SCORE</label><select id="fScore">
          <option value="" ${state.filters.minQualityScore === "" ? "selected" : ""}>Show every score</option>
          <option value="70" ${state.filters.minQualityScore === "70" ? "selected" : ""}>70+ actionable</option>
          <option value="85" ${state.filters.minQualityScore === "85" ? "selected" : ""}>85+ smart watch</option>
          <option value="90" ${state.filters.minQualityScore === "90" ? "selected" : ""}>90+ strongest only</option>
        </select></div>
        <div><label class="field">MIN LIQUIDITY</label><select id="fLiq">
          <option value="">Any / newly detected</option>
          <option value="10000" ${state.filters.minLiquidityUsd === "10000" ? "selected" : ""}>$10k+</option>
          <option value="50000" ${state.filters.minLiquidityUsd === "50000" ? "selected" : ""}>$50k+</option>
          <option value="250000" ${state.filters.minLiquidityUsd === "250000" ? "selected" : ""}>$250k+</option>
          <option value="1000000" ${state.filters.minLiquidityUsd === "1000000" ? "selected" : ""}>$1M+</option>
        </select></div>
        <div><label class="field">MIN MARKET CAP</label><select id="fCap">
          <option value="" ${state.filters.minMarketCapUsd === "" ? "selected" : ""}>Any reported cap</option>
          <option value="100000" ${state.filters.minMarketCapUsd === "100000" ? "selected" : ""}>$100k+</option>
          <option value="1000000" ${state.filters.minMarketCapUsd === "1000000" ? "selected" : ""}>$1M+</option>
          <option value="10000000" ${state.filters.minMarketCapUsd === "10000000" ? "selected" : ""}>$10M+</option>
        </select></div>
        <div><label class="field">MARKET AGE</label><select id="fAge">
          <option value="" ${state.filters.marketAge === "" ? "selected" : ""}>Any age</option>
          <option value="new24h" ${state.filters.marketAge === "new24h" ? "selected" : ""}>New + trending · &lt;24h</option>
          <option value="age1h" ${state.filters.marketAge === "age1h" ? "selected" : ""}>Established · 1h+</option>
          <option value="age1d" ${state.filters.marketAge === "age1d" ? "selected" : ""}>Proven · 1d+</option>
          <option value="age7d" ${state.filters.marketAge === "age7d" ? "selected" : ""}>Long-running · 7d+</option>
        </select></div>
        <div><label class="field">MIN 5M VOLUME</label><select id="fVolume">
          <option value="" ${state.filters.minVolume5mUsd === "" ? "selected" : ""}>Any activity</option>
          <option value="5000" ${state.filters.minVolume5mUsd === "5000" ? "selected" : ""}>$5k+</option>
          <option value="25000" ${state.filters.minVolume5mUsd === "25000" ? "selected" : ""}>$25k+</option>
          <option value="100000" ${state.filters.minVolume5mUsd === "100000" ? "selected" : ""}>$100k+</option>
        </select></div>
        <div><label class="field">MAX RISK</label><select id="fRisk">
          <option value="" ${state.filters.maxRiskScore === "" ? "selected" : ""}>Any risk</option>
          <option value="45" ${state.filters.maxRiskScore === "45" ? "selected" : ""}>45 · medium or less</option>
          <option value="25" ${state.filters.maxRiskScore === "25" ? "selected" : ""}>25 · cautious</option>
          <option value="15" ${state.filters.maxRiskScore === "15" ? "selected" : ""}>15 · strict</option>
        </select></div>
        <div><label class="field">RANK BY</label><select id="fSort">
          <option value="score" ${state.filters.sort === "score" ? "selected" : ""}>Live score</option>
          <option value="volume" ${state.filters.sort === "volume" ? "selected" : ""}>5m volume</option>
          <option value="marketCap" ${state.filters.sort === "marketCap" ? "selected" : ""}>Market cap</option>
          <option value="newest" ${state.filters.sort === "newest" ? "selected" : ""}>Newest first</option>
        </select></div>
        <div class="feed-source">${sourceBadge(feed.source)}<span class="tiny muted">Re-scored every second · production floor ${usd(feed.policy.minLiquidityUsd)} liquidity · ${esc(feed.policy.maxPriceImpactPct)}% max impact.</span></div>
      </div>

      <div id="signalBoard" class="signal-board"></div>
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
    const signalBoard = container.querySelector("#signalBoard");
    const pulse = container.querySelector(".feed-pulse");
    const liveAge = container.querySelector(".live-age");
    let feedSignature = "";
    const signatureFor = (value) => JSON.stringify(value.tokens.map((token) => [
      token.mint,
      token.priceUsd,
      token.liquidityUsd,
      token.marketCapUsd,
      token.fiveMinuteVolumeUsd,
      token.stats5m,
      token.assessment,
    ]));
    const paintFreshness = (nextFeed) => {
      pulse.classList.toggle("stale", nextFeed.reliability !== "fresh");
      liveAge.textContent = `${nextFeed.reliability === "fresh" ? "LIVE" : "DELAYED"} · source age ${(nextFeed.ageMilliseconds / 1000).toFixed(1)}s`;
    };

    const paintFeed = (nextFeed) => {
      const paperCandidates = nextFeed.tokens.filter((token) => token.assessment.autoPaperEligible);
      const smartWatch = nextFeed.tokens.filter((token) => token.assessment.autoWatchEligible);
      const newMovers = nextFeed.tokens.filter((token) => token.marketAgeSeconds !== null && token.marketAgeSeconds <= 86_400 && token.assessment.qualityScore >= 70);
      const grad = nextFeed.graduated || { hidden: 0, included: false, qualityScore: 70, maturityDays: 30 };
      signalBoard.innerHTML = `
        <div class="signal-cell paper"><div class="signal-count">${paperCandidates.length}</div><div><b>Paper portfolio queue</b><span>90+ · mature · low risk · exact gates still required</span></div></div>
        <div class="signal-cell watch"><div class="signal-count">${smartWatch.length}</div><div><b>Smart watchlist</b><span>85+ · strong evidence in this feed</span></div></div>
        <div class="signal-cell new"><div class="signal-count">${newMovers.length}</div><div><b>New + moving</b><span>under 24h old with a 70+ live signal</span></div></div>
        <div class="signal-cell graduated"><div class="signal-count">${grad.included ? "ON" : grad.hidden}</div><div><b>Auto-watch shelf</b><span>${grad.maturityDays}d+ old or ${grad.qualityScore}+ quality · kept out of Discover</span></div></div>`;
      listEl.innerHTML = nextFeed.tokens.length ? "" : `<div class="empty">No live tokens match these filters.</div>`;
      if (grad.hidden > 0 || grad.included) {
        const note = document.createElement("div");
        note.className = "graduated-note";
        note.innerHTML = grad.included
          ? `Showing established coins. <button type="button" class="linkish" id="gradToggle">Hide them again</button>`
          : `<b>${grad.hidden}</b> established ${grad.hidden === 1 ? "coin is" : "coins are"} on the auto-watch shelf, making room for new launches. <button type="button" class="linkish" id="gradToggle">Show them</button>`;
        listEl.appendChild(note);
      }
      for (const token of nextFeed.tokens) {
        listEl.appendChild(liveTokenCard({ ...token, inWatchlist: watchedMints.has(token.mint) }));
      }
      const gradToggle = listEl.querySelector("#gradToggle");
      if (gradToggle) {
        gradToggle.addEventListener("click", () => {
          state.filters.includeGraduated = !state.filters.includeGraduated;
          render();
        });
      }
      feedSignature = signatureFor(nextFeed);
      paintFreshness(nextFeed);
    };
    paintFeed(feed);

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

    for (const [id, key] of [
      ["fScore", "minQualityScore"],
      ["fCap", "minMarketCapUsd"],
      ["fAge", "marketAge"],
      ["fVolume", "minVolume5mUsd"],
      ["fRisk", "maxRiskScore"],
      ["fSort", "sort"],
    ]) {
      container.querySelector(`#${id}`).addEventListener("change", (event) => {
        state.filters[key] = event.target.value;
        render();
      });
    }

    // Wire global search and begin non-overlapping one-second market refreshes
    // after the view is attached. Portfolio/watchlist requests are not repeated.
    return () => {
      wireSearch();
      let stopped = false;
      let timer = null;
      let controller = null;
      const tick = async () => {
        controller = new AbortController();
        try {
          const nextFeed = await api(`/v1/feed?${liveFeedParams()}`, { signal: controller.signal });
          if (!stopped && listEl.isConnected) {
            const interacting = state.modalOpen
              || listEl.contains(document.activeElement)
              || Boolean(listEl.querySelector(".sm-store:disabled, .score-details[open]"));
            if (!interacting && signatureFor(nextFeed) !== feedSignature) paintFeed(nextFeed);
            else paintFreshness(nextFeed);
          }
          if (!stopped) timer = setTimeout(tick, Math.max(1_000, nextFeed.refreshAfterMs || 1_000));
        } catch (error) {
          if (stopped || error.name === "AbortError") return;
          pulse.classList.add("stale");
          liveAge.textContent = "DELAYED · retrying live feed";
          timer = setTimeout(tick, 5_000);
        }
      };
      timer = setTimeout(tick, Math.max(1_000, feed.refreshAfterMs || 1_000));
      return () => {
        stopped = true;
        clearTimeout(timer);
        controller?.abort();
      };
    };
  }

  function liveTokenCard(token) {
    const div = document.createElement("article");
    div.className = "opp-card live-token-card";
    const assessment = token.assessment;
    const firstSeen = token.firstPoolAtMs ? ago(token.firstPoolAtMs) : "time unavailable";
    const marketAge = token.marketAgeSeconds == null
      ? "age unavailable"
      : token.marketAgeSeconds < 60
        ? `${token.marketAgeSeconds}s old`
        : token.marketAgeSeconds < 3_600
          ? `${Math.floor(token.marketAgeSeconds / 60)}m old`
          : token.marketAgeSeconds < 86_400
            ? `${Math.floor(token.marketAgeSeconds / 3_600)}h old`
            : `${Math.floor(token.marketAgeSeconds / 86_400)}d old`;
    const price = token.priceUsd == null ? "—" : `$${token.priceUsd}`;
    const liquidity = token.liquidityUsd == null ? "not reported" : usd(token.liquidityUsd);
    const marketCap = token.marketCapUsd == null ? "not reported" : usd(token.marketCapUsd);
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
    const fomoUrl = fomoCoinUrl(token.mint);
    const signalChip = assessment.autoPaperEligible
      ? `<span class="chip signal-paper">PAPER QUEUE</span>`
      : assessment.autoWatchEligible
        ? `<span class="chip signal-watch">SMART WATCH</span>`
        : assessment.signal === "watch"
          ? `<span class="chip signal-live">WATCH LIVE</span>`
          : "";
    const scoreBreakdown = (assessment.scoreBreakdown || [])
      .map((part) => `<div><span>${esc(part.label)}</span><b>${part.score}/${part.maxScore}</b><small>${esc(part.detail)}</small></div>`)
      .join("");

    div.innerHTML = `
      <div class="opp-emoji token-icon">${icon}</div>
      <div class="opp-main">
        <div class="opp-title">
          <span class="live-rank">#${token.rank ?? "—"}</span>
          <span class="sym">${esc(token.symbol)}</span>
          <span class="muted small">${esc(token.name)}</span>
          ${signalChip}
          <span class="chip ${assessment.status === "active" ? "live-chip" : "unver-chip"}">${statusLabel}</span>
          ${riskChip(assessment.riskLevel)}
        </div>
        <div class="mint-line mono" title="${esc(token.mint)}">${esc(token.mint.slice(0, 8))}…${esc(token.mint.slice(-6))} · ${marketAge} · first pool ${firstSeen}${token.launchpad ? ` · ${esc(token.launchpad)}` : ""}</div>
        <div class="opp-metrics mono">
          <span>Price <b>${esc(price)}</b></span>
          <span>5m <b class="${cls(change5m || 0)}">${change5m == null ? "—" : `${sign(change5m)}${esc(change5m)}%`}</b></span>
          <span>Vol 5m <b>${esc(vol5m)}</b></span>
          <span>Liquidity <b>${esc(liquidity)}</b></span>
          <span>Market cap <b>${esc(marketCap)}</b></span>
          <span>Traders 5m <b>${token.stats5m.traders ?? "—"}</b></span>
          <span>Trend <b>${esc(assessment.trendAlignment?.label ?? "—")}</b></span>
          <span>Evidence <b>${assessment.confidenceScore}/100</b></span>
        </div>
        <div class="opp-why">${warnings || `<span class="fx positive">No immediate catalog warnings</span>`}</div>
        <div class="eligibility tiny muted">${esc(assessment.eligibility)}</div>
        <details class="score-details"><summary>Why this score</summary><div class="score-grid">${scoreBreakdown}</div><p>Risk adjustment: −${Math.floor(assessment.riskScore / 5)} · live score is evidence-weighted, not a profit probability.</p></details>
        <div class="gate-check-out">${storedGateReport ? gateReportHtml(storedGateReport, true) : ""}</div>
      </div>
      <div class="opp-side">
        <div class="opp-score"><div class="n">${assessment.qualityScore}</div><div class="d">LIVE SCORE / 100</div></div>
        <div class="tiny signal-action">${esc(assessment.actionLabel)}</div>
        ${freshness(token.updatedAgeSeconds ?? 999, token.reliability)}
        <div class="row" style="flex-wrap:wrap;justify-content:flex-end">
          <button class="star ${token.inWatchlist ? "active" : ""}" title="Watchlist" aria-label="Toggle watchlist">★</button>
          <button class="btn sm-store" title="Run fresh safety gates, then store a $100 simulated position">Store in portfolio</button>
          <a class="btn sm-fomo" href="${esc(fomoUrl)}" target="_blank" rel="noopener noreferrer" title="Open this exact Solana mint in FOMO; choose the amount and confirm there">Trade on FOMO ↗</a>
        </div>
      </div>
    `;

    div.querySelector(".sm-store").addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!session.authenticated) {
        openAccessModal();
        return;
      }
      const button = event.currentTarget;
      const out = div.querySelector(".gate-check-out");
      button.disabled = true;
      button.textContent = "Checking safety…";
      out.innerHTML = `<div class="sstate"><div class="spinner"></div>Verifying route and chain…</div>`;
      try {
        const report = await api(`/v1/tradability/${encodeURIComponent(token.mint)}?amountUsd=100&slippageBps=50`);
        state.gateReports.set(token.mint, report);
        out.innerHTML = gateReportHtml(report, true);
        if (!livePaperReportIsUsable(report)) {
          button.textContent = "Store in portfolio";
          toast(`${token.symbol} did not pass the fresh portfolio safety gates`, "error");
          return;
        }
        button.textContent = "Storing…";
        const clientRequestId = state.portfolioRequestIds.get(token.mint) ?? crypto.randomUUID();
        state.portfolioRequestIds.set(token.mint, clientRequestId);
        const body = await post("/v1/me/paper/positions", {
          clientRequestId,
          tokenMint: token.mint,
          amountUsd: "100",
          slippageBps: 50,
        });
        state.portfolioRequestIds.delete(token.mint);
        toast(`${body.position.token.symbol} stored in your simulated portfolio`, "ok");
        location.hash = "#/portfolio";
        if (state.route.name === "portfolio") render();
      } catch (err) {
        out.innerHTML = `<div class="unavail-block"><div class="unavail-title">Could not store this position</div><div class="tiny muted">${esc(err.message)}</div></div>`;
        button.textContent = "Retry store";
      } finally {
        button.disabled = false;
      }
    });
    div.querySelector(".star").addEventListener("click", async (event) => {
      if (!session.authenticated) {
        openAccessModal();
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

    /**
     * Wallet-held supply, measured from token accounts.
     *
     * Shown separately from the pooled share on purpose: a big pool number is
     * reassuring (deep liquidity) while a big wallet number is not, and
     * collapsing them into one percentage is what makes naive rug scanners
     * flag healthy tokens.
     */
    const holderRow = (v) => {
      const h = v && v.holders;
      if (!h) return "";
      const term = "Share of supply held by keypair wallets, excluding pools and bonding curves.";
      const measured = h.status !== "unavailable" && typeof h.concentrationBps === "number";
      const pct = measured ? (h.concentrationBps / 100).toFixed(1) + "%" : null;
      const dot = !measured ? "attn" : h.concentrationBps >= 5000 ? "bad" : h.concentrationBps >= 3000 ? "attn" : "ok";
      return `
        <div class="fact">
          <div class="fact-head">
            <span class="fact-label">Wallet-held supply<span class="info" tabindex="0" role="note" aria-label="${esc(term)}" title="${esc(term)}">i</span></span>
            <span class="fact-value">${pct ? `<i class="dot ${dot}"></i>${esc(h.status === "incomplete" ? "≥ " + pct : pct)}` : `<span class="unavail">Unknown</span>`}</span>
          </div>
          <div class="fact-meta">${sourceBadge("solana-rpc:mainnet")}<span class="fact-why">${esc(h.detail)}</span></div>
        </div>`;
    };

    container.innerHTML = `
      <button class="back" id="backBtn">← Back to search</button>

      <div class="research-head">
        <div class="rh-icon">${d.iconUrl ? `<img src="${esc(d.iconUrl)}" alt="" data-remove-on-error="true">` : "◎"}</div>
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
              ${holderRow(v)}
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
      if (!session.authenticated) return openAccessModal();
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
          <span class="chip ${open ? "live-chip" : ""}">${open ? "OPEN" : "CLOSED"} · ${position.managedByPaperBot ? "SHADOW BOT" : "LIVE-QUOTE PAPER"}</span>
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
        ${p.positions.length ? "" : `<div class="empty" style="padding:26px 12px">No positions yet.<br><span class="tiny faint">Choose Store in portfolio on a live token; Moonpaper checks every safety gate before saving the simulated position.</span></div>`}
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

  // ---------- Bot Lab (opt-in shadow paper bot) ----------
  async function renderBot(container) {
    if (!session.authenticated) {
      container.innerHTML = signInPrompt("the paper bot lab");
      return wireSignInPrompt;
    }
    const body = await api("/v1/me/paper-bot?limit=40");
    const c = body.config;
    const pct = (bps) => Number(bps) / 100;
    const runStatus = c.lastRunStatus ?? "waiting";
    const decisionLabel = {
      opened: "Opened paper position",
      entry_rejected: "Entry rejected",
      closed: "Closed paper position",
      exit_unavailable: "Exit quote unavailable",
      scan_empty: "No qualifying candidate",
      error: "Worker error",
    };
    const decisionClass = (action) =>
      action === "opened" || action === "closed"
        ? "ok"
        : action === "entry_rejected" || action === "scan_empty"
          ? "warn"
          : "error";
    const decisionHtml = (d) => `
      <div class="bot-decision">
        <div class="row spread" style="align-items:flex-start;flex-wrap:wrap">
          <div>
            <span class="chip bot-${decisionClass(d.action)}">${esc(decisionLabel[d.action] ?? d.action)}</span>
            ${d.tokenSymbol ? `<b style="margin-left:7px">${esc(d.tokenSymbol)}</b>` : ""}
          </div>
          <span class="tiny faint">${ago(d.createdAtMs)}</span>
        </div>
        <div class="small muted" style="margin-top:8px">${esc(d.reason)}</div>
        ${d.qualityScore === null && d.riskScore === null ? "" : `<div class="tiny faint" style="margin-top:6px">Quality ${d.qualityScore ?? "—"}/100 · risk ${d.riskScore ?? "—"}/100</div>`}
        ${d.tokenMint ? `<button class="back bot-research" data-mint="${esc(d.tokenMint)}" style="margin-top:7px">Research mint →</button>` : ""}
      </div>`;

    container.innerHTML = `
      <div class="bot-hero card">
        <div>
          <div class="eyebrow">AUTOMATED PAPER TRADING</div>
          <h2 style="margin-top:5px">Shadow Bot Lab</h2>
          <p class="small muted" style="max-width:680px;margin-top:6px">Scans Jupiter's five-minute trending feed, reruns Moonpaper's on-chain and exact-quote production gates, then opens and manages virtual positions. Every decision is recorded below.</p>
        </div>
        <div class="bot-status ${c.enabled ? "enabled" : "disabled"}">
          <i></i>${c.enabled ? "ENABLED" : "OFF"}
        </div>
      </div>
      <div class="sim-notice" style="margin:12px 0 16px"><b>Simulation only.</b> This bot cannot access a wallet, build a transaction, sign, submit, or move funds. Enabling it authorizes only automatic changes to your virtual Moonpaper portfolio.</div>

      <div class="detail-grid bot-layout">
        <div class="card">
          <div class="row spread" style="margin-bottom:13px;flex-wrap:wrap">
            <h3>Strategy controls</h3>
            <label class="bot-toggle"><input type="checkbox" id="botEnabled" ${c.enabled ? "checked" : ""}> Run shadow bot</label>
          </div>
          <div class="bot-fields">
            <div><label class="field">VIRTUAL USD PER ENTRY</label><input type="number" id="botTradeSize" min="10" max="10000" step="10" value="${esc(c.tradeSizeUsd)}"></div>
            <div><label class="field">MAX OPEN BOT POSITIONS</label><input type="number" id="botMaxOpen" min="1" max="10" step="1" value="${c.maxOpenPositions}"></div>
            <div><label class="field">MIN QUALITY SCORE</label><input type="number" id="botMinQuality" min="0" max="100" step="1" value="${c.minQualityScore}"></div>
            <div><label class="field">MAX RISK SCORE</label><input type="number" id="botMaxRisk" min="0" max="100" step="1" value="${c.maxRiskScore}"></div>
            <div><label class="field">MIN LIQUIDITY (USD)</label><input type="number" id="botMinLiquidity" min="10000" max="1000000000" step="10000" value="${esc(c.minLiquidityUsd)}"></div>
            <div><label class="field">MAX ENTRY IMPACT (%)</label><input type="number" id="botMaxImpact" min="0.01" max="3" step="0.01" value="${pct(c.maxPriceImpactBps)}"></div>
            <div><label class="field">SLIPPAGE ASSUMPTION (%)</label><input type="number" id="botSlippage" min="0.01" max="5" step="0.01" value="${pct(c.slippageBps)}"></div>
            <div><label class="field">TAKE PROFIT (%)</label><input type="number" id="botTakeProfit" min="1" max="100" step="0.5" value="${pct(c.takeProfitBps)}"></div>
            <div><label class="field">STOP LOSS (%)</label><input type="number" id="botStopLoss" min="1" max="50" step="0.5" value="${pct(c.stopLossBps)}"></div>
            <div><label class="field">TRAILING STOP (%) · 0 OFF</label><input type="number" id="botTrailing" min="0" max="50" step="0.5" value="${pct(c.trailingStopBps)}"></div>
            <div><label class="field">MAX HOLD (MINUTES)</label><input type="number" id="botMaxHold" min="5" max="10080" step="5" value="${c.maxHoldMinutes}"></div>
            <div><label class="field">RE-ENTRY COOLDOWN (MINUTES)</label><input type="number" id="botCooldown" min="1" max="1440" step="1" value="${c.cooldownMinutes}"></div>
          </div>
          <button class="btn" id="saveBot" style="width:100%;margin-top:16px">Save shadow strategy</button>
          <div class="tiny faint" style="margin-top:8px">Version ${esc(c.strategyVersion)} · defaults are experimental test parameters, not financial advice.</div>
        </div>

        <div class="grid">
          <div class="card">
            <h3>Worker status</h3>
            <div class="kv"><span class="k">State</span><span class="v"><span class="chip bot-${runStatus === "ok" ? "ok" : runStatus === "waiting" ? "warn" : "error"}">${esc(runStatus.toUpperCase())}</span></span></div>
            <div class="kv"><span class="k">Last evaluated</span><span class="v">${c.lastRunAtMs ? ago(c.lastRunAtMs) : "Not yet"}</span></div>
            <div class="small muted" style="margin-top:10px">${esc(c.lastRunSummary ?? (c.enabled ? "Waiting for the background worker's first pass." : "Enable the bot to start simulated scans."))}</div>
          </div>
          <div class="card">
            <h3>What must pass before entry</h3>
            <ul class="bot-checks">
              <li>Fresh five-minute trending data and configured quality score</li>
              <li>Configured liquidity and risk ceilings</li>
              <li>Solana mint and freeze authorities verified as revoked</li>
              <li>Fresh exact-size Jupiter route within impact policy</li>
              <li>Virtual cash, cooldown, and position limits</li>
            </ul>
          </div>
        </div>
      </div>

      <div class="row spread" style="margin:22px 0 10px;flex-wrap:wrap">
        <h3>Decision audit trail</h3>
        <span class="tiny muted">Newest first · accepted and rejected decisions</span>
      </div>
      <div class="bot-decisions">${body.decisions.length ? body.decisions.map(decisionHtml).join("") : `<div class="empty">No bot decisions yet. The first worker pass will appear here after you enable the shadow bot.</div>`}</div>
    `;

    const strategyPayload = () => ({
      enabled: $("botEnabled").checked,
      tradeSizeUsd: $("botTradeSize").value,
      minQualityScore: Number($("botMinQuality").value),
      maxRiskScore: Number($("botMaxRisk").value),
      minLiquidityUsd: $("botMinLiquidity").value,
      maxPriceImpactBps: Math.round(Number($("botMaxImpact").value) * 100),
      slippageBps: Math.round(Number($("botSlippage").value) * 100),
      maxOpenPositions: Number($("botMaxOpen").value),
      takeProfitBps: Math.round(Number($("botTakeProfit").value) * 100),
      stopLossBps: Math.round(Number($("botStopLoss").value) * 100),
      trailingStopBps: Math.round(Number($("botTrailing").value) * 100),
      maxHoldMinutes: Number($("botMaxHold").value),
      cooldownMinutes: Number($("botCooldown").value),
    });
    const persist = async (payload) => {
      const save = $("saveBot");
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        await put("/v1/me/paper-bot", payload);
        toast(payload.enabled ? "Shadow bot enabled — simulation only" : "Shadow bot settings saved", "ok");
        render();
      } catch (err) {
        toast(err.message, "error");
        save.disabled = false;
        save.textContent = "Save shadow strategy";
      }
    };
    container.querySelector("#saveBot").addEventListener("click", () => {
      const payload = strategyPayload();
      if (payload.enabled && !c.enabled) {
        showModal(`
          <h3>Enable automatic paper trading?</h3>
          <div class="sim-notice">This authorizes Moonpaper's background worker to open and close <b>virtual</b> positions under these limits. It does not authorize real trading and cannot access a wallet.</div>
          <div class="kv"><span class="k">Virtual entry size</span><span class="v mono">$${esc(payload.tradeSizeUsd)}</span></div>
          <div class="kv"><span class="k">Maximum bot positions</span><span class="v mono">${payload.maxOpenPositions}</span></div>
          <div class="kv"><span class="k">Stop / target</span><span class="v mono">-${payload.stopLossBps / 100}% / +${payload.takeProfitBps / 100}%</span></div>
          <div class="actions"><button class="btn secondary" data-close>Cancel</button><button class="btn" id="confirmBotEnable">Enable shadow bot</button></div>
        `);
        $("confirmBotEnable").addEventListener("click", () => {
          closeModal();
          persist(payload);
        });
      } else {
        persist(payload);
      }
    });
    container.querySelectorAll(".bot-research").forEach((button) =>
      button.addEventListener("click", () => {
        location.hash = `#/research/${button.dataset.mint}`;
      }),
    );
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

  async function renderEmailVerification(container, rawToken) {
    container.innerHTML = `<div class="loading-block"><div class="spinner"></div>Verifying your email…</div>`;
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(rawToken)) throw new Error("This verification link is invalid or expired.");
      await post("/v1/auth/verify-email", { token: rawToken });
      // Remove the bearer secret from browser history as soon as it has been
      // consumed, even though fragments never reach the HTTP server.
      history.replaceState(null, "", `${location.pathname}${location.search}#/`);
      state.route = { name: "discover" };
      await loadSession();
      container.innerHTML = `
        <div class="empty">
          <div style="font-size:18px;font-weight:800;color:var(--green);margin-bottom:8px">Email verified</div>
          <div>Your paper portfolio and watchlist actions are now enabled.</div>
          <button class="btn" id="verificationContinue" style="margin-top:16px">Continue researching</button>
        </div>`;
      return () => $("verificationContinue").addEventListener("click", render);
    } catch (error) {
      container.innerHTML = `
        <div class="empty">
          <div style="font-size:16px;font-weight:800;color:var(--red);margin-bottom:8px">Could not verify this email</div>
          <div>${esc(error.message)}</div>
          ${session.authenticated ? `<button class="btn secondary" id="verificationResend" style="margin-top:16px">Send a new link</button>` : ""}
        </div>`;
      return () => {
        const resend = $("verificationResend");
        if (resend) resend.addEventListener("click", resendVerification);
      };
    }
  }

  function renderPasswordReset(container, rawToken) {
    container.innerHTML = `
      <section class="panel" style="max-width:520px;margin:40px auto">
        <h2>Choose a new password</h2>
        <p class="small muted" style="margin-top:6px">Use at least 10 characters. Updating it signs the account out on every device.</p>
        <div id="resetErr" class="error-box hidden"></div>
        <label class="field" style="margin-top:14px">NEW PASSWORD</label>
        <input type="password" id="resetPassword" autocomplete="new-password" placeholder="At least 10 characters">
        <label class="field" style="margin-top:10px">CONFIRM PASSWORD</label>
        <input type="password" id="resetConfirm" autocomplete="new-password" placeholder="Repeat your new password">
        <div class="actions"><button class="btn" id="resetSubmit">Update password</button></div>
      </section>`;
    return () => {
      const submit = async () => {
        const errorBox = $("resetErr");
        const password = $("resetPassword").value;
        const confirm = $("resetConfirm").value;
        errorBox.classList.add("hidden");
        if (password !== confirm) {
          errorBox.textContent = "The passwords do not match.";
          errorBox.classList.remove("hidden");
          return;
        }
        const button = $("resetSubmit");
        button.disabled = true;
        button.textContent = "Updating…";
        try {
          if (!/^[A-Za-z0-9_-]{43}$/.test(rawToken)) throw new Error("This password-reset link is invalid or expired.");
          await post("/v1/auth/reset-password", { token: rawToken, password });
          history.replaceState(null, "", `${location.pathname}${location.search}#/`);
          state.route = { name: "discover" };
          session.authenticated = false;
          session.user = null;
          renderAccountArea();
          openAccessModal();
          toast("Password updated — sign in again", "ok");
          render();
        } catch (error) {
          errorBox.textContent = error.message;
          errorBox.classList.remove("hidden");
          button.disabled = false;
          button.textContent = "Update password";
        }
      };
      $("resetSubmit").addEventListener("click", submit);
      $("resetConfirm").addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
      });
      $("resetPassword").focus();
    };
  }

  // ---------- render root ----------
  let renderSeq = 0;
  let activeViewCleanup = null;
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
      if (state.route.name === "verify-email") after = await renderEmailVerification(target, state.route.token);
      else if (state.route.name === "reset-password") after = renderPasswordReset(target, state.route.token);
      else if (state.route.name === "research") after = await renderResearch(target, state.route.mint);
      else if (state.route.name === "token") after = await renderToken(target, state.route.mint);
      else if (state.route.name === "portfolio") after = await renderAccountPortfolio(target);
      else if (state.route.name === "bot") after = await renderBot(target);
      else if (state.route.name === "watchlist") after = await renderWatchlist(target);
      else if (state.route.name === "simulator") after = await renderPortfolio(target);
      else if (state.route.name === "settings") after = await renderSettings(target);
      else after = await renderDiscover(target);
      if (seq !== renderSeq) return; // a newer render superseded this one
      activeViewCleanup?.();
      activeViewCleanup = null;
      container.innerHTML = "";
      container.append(...target.children);
      container.dataset.loaded = "1";
      if (typeof after === "function") {
        const cleanup = after();
        if (typeof cleanup === "function") activeViewCleanup = cleanup;
      }
    } catch (err) {
      if (seq !== renderSeq) return;
      container.innerHTML = `<div class="empty">⚠ ${esc(err.message)}<br><br><button class="btn secondary" id="renderRetry">Retry</button></div>`;
      $("renderRetry").addEventListener("click", () => location.reload());
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
        state.modalOpen ||
        typing ||
        search.open ||
        state.route.name === "settings" ||
        state.route.name === "bot" ||
        state.route.name === "research";
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
