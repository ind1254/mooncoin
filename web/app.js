/* Moonpaper — front end (vanilla JS, no build step).
   Talks to the local backend; every value shown is simulated demo data. */
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

  async function api(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch {
      throw new Error("Cannot reach the local backend — is it running? (npm run dev in backend/)");
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      const msg = body?.message || `Request failed (${res.status})`;
      const err = new Error(msg);
      err.code = body?.error;
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
    filters: { search: "", risk: "", minLiquidityUsd: "", tradeSizeSol: null },
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
    if (h.startsWith("token/")) return { name: "token", mint: h.slice(6) };
    if (h === "portfolio" || h === "settings") return { name: h };
    return { name: "discover" };
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
      const target = state.route.name === "token" ? "discover" : state.route.name;
      b.classList.toggle("active", b.dataset.nav === target);
    });
  }

  // ---------- chips & shared fragments ----------
  const oppChip = (label) => `<span class="chip ${esc(label)}">${esc(label).toUpperCase()}</span>`;
  const riskChip = (level) => `<span class="chip risk-${esc(level)}">RISK: ${esc(level).toUpperCase()}</span>`;
  const freshness = (ageS, reliability) =>
    `<span class="freshness ${reliability !== "fresh" ? "stale" : ""}">${reliability === "fresh" ? `data ${ageS}s old` : `⚠ data ${ageS}s old (stale)`}</span>`;

  // ---------- Discover ----------
  async function renderDiscover(container) {
    const size = state.filters.tradeSizeSol ?? 10;
    const params = new URLSearchParams({ tradeSizeSol: String(size) });
    if (state.filters.risk) params.set("risk", state.filters.risk);
    if (state.filters.minLiquidityUsd) params.set("minLiquidityUsd", state.filters.minLiquidityUsd);
    if (state.filters.search) params.set("search", state.filters.search);

    const [opps, portfolio] = await Promise.all([api(`/v1/opportunities?${params}`), api("/v1/paper/portfolio")]);
    const s = portfolio.stats;
    const unrl = num(s.totalUnrealizedPnlSol);
    const watchSet = new Set(state.settings?.watchlist ?? []);
    const watchItems = opps.opportunities.filter((o) => watchSet.has(o.token.mint));

    container.innerHTML = `
      <div class="summary-strip">
        <div class="stat"><div class="k">VIRTUAL BALANCE</div><div class="v mono">${esc(portfolio.cashSol)} SOL</div><div class="s">simulated cash</div></div>
        <div class="stat"><div class="k">PORTFOLIO VALUE</div><div class="v mono">${esc(portfolio.totalValueSol)} SOL</div><div class="s">started with ${esc(portfolio.startingBalanceSol)} SOL</div></div>
        <div class="stat"><div class="k">OPEN P&amp;L</div><div class="v mono ${unrl > 0 ? "up" : unrl < 0 ? "down" : ""}">${sign(s.totalUnrealizedPnlSol)}${esc(s.totalUnrealizedPnlSol)} SOL</div><div class="s">${s.openCount} open position${s.openCount === 1 ? "" : "s"}</div></div>
        <div class="stat"><div class="k">WIN RATE</div><div class="v mono">${s.closedCount ? s.winRatePct + "%" : "—"}</div><div class="s">${s.closedCount} closed paper trades</div></div>
      </div>

      <div class="filters">
        <div class="search"><label class="field">SEARCH</label><input type="text" id="fSearch" placeholder="Token, name, or mint…" value="${esc(state.filters.search)}"></div>
        <div><label class="field">PAPER TRADE SIZE</label><select id="fSize">
          ${[1, 5, 10, 25].map((n) => `<option value="${n}" ${n === Number(size) ? "selected" : ""}>${n} SOL</option>`).join("")}
        </select></div>
        <div><label class="field">MAX RISK</label><select id="fRisk">
          <option value="">Any risk</option>
          <option value="low" ${state.filters.risk === "low" ? "selected" : ""}>Low only</option>
          <option value="medium" ${state.filters.risk === "medium" ? "selected" : ""}>Low + medium</option>
        </select></div>
        <div><label class="field">MIN LIQUIDITY</label><select id="fLiq">
          <option value="">Any</option>
          <option value="250000" ${state.filters.minLiquidityUsd === "250000" ? "selected" : ""}>$250k+</option>
          <option value="1000000" ${state.filters.minLiquidityUsd === "1000000" ? "selected" : ""}>$1M+</option>
          <option value="5000000" ${state.filters.minLiquidityUsd === "5000000" ? "selected" : ""}>$5M+</option>
        </select></div>
      </div>

      ${watchItems.length ? `<h2>⭐ Watchlist</h2><div id="watchList"></div>` : ""}
      <h2>Ranked opportunities <span class="tiny muted">for a ${esc(String(size))} SOL simulated trade · ${esc(opps.dataSource)}</span></h2>
      <div id="oppList">${opps.opportunities.length ? "" : `<div class="empty">No tokens match these filters.</div>`}</div>
    `;

    const listEl = container.querySelector("#oppList");
    for (const o of opps.opportunities) listEl.appendChild(oppCard(o));
    const watchEl = container.querySelector("#watchList");
    if (watchEl) for (const o of watchItems) watchEl.appendChild(oppCard(o));

    container.querySelector("#fSearch").addEventListener("change", (e) => {
      state.filters.search = e.target.value.trim();
      render();
    });
    container.querySelector("#fSize").addEventListener("change", (e) => {
      state.filters.tradeSizeSol = Number(e.target.value);
      render();
    });
    container.querySelector("#fRisk").addEventListener("change", (e) => {
      state.filters.risk = e.target.value;
      render();
    });
    container.querySelector("#fLiq").addEventListener("change", (e) => {
      state.filters.minLiquidityUsd = e.target.value;
      render();
    });
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
          ${oppChip(o.opportunityLabel)} ${riskChip(o.riskLevel)}
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

          <div class="card">
            <h3>Token risk facts</h3>
            <div class="kv"><span class="k">Token age</span><span class="v">${d.riskFacts.tokenAgeDays} days</span></div>
            <div class="kv"><span class="k">Top-10 holder share</span><span class="v">${esc(d.riskFacts.holderConcentrationPct)}%</span></div>
            <div class="kv"><span class="k">Mint authority</span><span class="v ${d.riskFacts.mintAuthorityRevoked ? "up" : "down"}">${d.riskFacts.mintAuthorityRevoked ? "Revoked ✓" : "STILL ACTIVE ⚠"}</span></div>
            <div class="kv"><span class="k">Freeze authority</span><span class="v ${d.riskFacts.freezeAuthorityRevoked ? "up" : "down"}">${d.riskFacts.freezeAuthorityRevoked ? "Revoked ✓" : "STILL ACTIVE ⚠"}</span></div>
            <div class="kv"><span class="k">Insider activity</span><span class="v ${d.riskFacts.recentInsiderActivity ? "down" : "up"}">${d.riskFacts.recentInsiderActivity ? "Detected ⚠" : "None seen"}</span></div>
            <div class="kv"><span class="k">Risk data</span><span class="v ${d.riskFacts.dataComplete ? "" : "warn"}">${d.riskFacts.dataComplete ? "Complete" : "Incomplete ⚠"}</span></div>
            <div class="tiny faint" style="margin-top:8px">Sources: ${d.freshness.map((f) => `${esc(f.field)} ${f.ageSeconds}s${f.reliability !== "fresh" ? " (stale⚠)" : ""}`).join(" · ")}</div>
          </div>

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

  // ---------- Portfolio ----------
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
      if (state.route.name === "token") after = await renderToken(target, state.route.mint);
      else if (state.route.name === "portfolio") after = await renderPortfolio(target);
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

  // Update the banner with the backend's own data-source label
  api("/v1/meta")
    .then((m) => {
      $("dataBanner").textContent = `PAPER TRADING PROTOTYPE — ${m.dataSource} · all trades simulated · live execution disabled`;
    })
    .catch(() => {
      $("dataBanner").textContent = "BACKEND OFFLINE — start it with: cd backend && npm run dev";
    });

  // Gentle auto-refresh that never fights the user
  setInterval(() => {
    const el = document.activeElement;
    const typing = el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
    if (!state.modalOpen && !typing && state.route.name !== "settings") render();
    refreshNotifications();
  }, 15_000);

  state.route = parseHash();
  render();
  refreshNotifications();
})();
