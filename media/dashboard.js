/* Client-side renderer for the Claude Code Usage dashboard webview.
 *
 * The extension posts a serializable state snapshot ({type:'state', dto}); this
 * script keeps the last snapshot and re-renders every second so the 5-hour
 * countdown ticks and staleness updates live, without needing a new message.
 * Time-dependent math (countdown, age, active membership) is done here from
 * absolute timestamps (resets_at in epoch seconds, receivedAt in epoch ms).
 */
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  let state = null;

  function fmtCost(n) {
    const v = Number(n);
    return "$" + (isFinite(v) ? v : 0).toFixed(2);
  }
  // Deterministic thousands grouping (no locale dependence).
  function fmtInt(n) {
    const v = Math.round(Number(n) || 0);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function fmtCountdown(resetsAtSec, now) {
    if (typeof resetsAtSec !== "number" || !isFinite(resetsAtSec)) return "—";
    const ms = resetsAtSec * 1000 - now;
    if (ms <= 0) return "now";
    const t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m " + String(s).padStart(2, "0") + "s";
    return s + "s";
  }
  function fmtAge(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }
  function lvl(p) {
    if (p >= 90) return "crit";
    if (p >= 70) return "warn";
    return "ok";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function bar(pct, level) {
    const w = Math.max(0, Math.min(100, pct));
    return '<div class="bar"><div class="bar-fill ' + level + '" style="width:' + w + '%"></div></div>';
  }

  function rateCard(title, rw, now, big) {
    if (!rw || typeof rw.pct !== "number") {
      return (
        '<div class="card"><div class="card-h">' +
        title +
        '</div><div class="sub">waiting for first API response…</div></div>'
      );
    }
    const level = lvl(rw.pct);
    const cd = fmtCountdown(rw.resetsAt, now);
    return (
      '<div class="card"><div class="card-h">' +
      title +
      '</div><div class="row"><span class="' +
      (big ? "big " : "mid ") +
      level +
      '">' +
      Math.round(rw.pct) +
      "%</span>" +
      '<span class="reset">resets in ' +
      cd +
      "</span></div>" +
      bar(rw.pct, level) +
      "</div>"
    );
  }

  function tokRow(label, val) {
    return '<div class="tok"><span class="tok-l">' + label + '</span><span class="tok-v">' + fmtInt(val) + "</span></div>";
  }

  function sessionDetail(s) {
    if (!s) return "";
    let h =
      '<div class="card"><div class="card-h">Context — ' +
      esc(s.model || "—") +
      (s.sessionName ? " · " + esc(s.sessionName) : "") +
      "</div>";

    if (typeof s.ctxPct === "number") {
      const over = s.ctxPct > 100;
      const level = lvl(s.ctxPct);
      h +=
        '<div class="row"><span class="mid ' +
        level +
        '">' +
        Math.round(s.ctxPct) +
        "%</span>" +
        '<span class="reset">' +
        (over ? "auto-compacted · indicative" : "indicative") +
        "</span></div>" +
        bar(s.ctxPct, level);
    } else {
      h += '<div class="sub">context % unavailable (null right after /compact or before first call)</div>';
    }

    if (s.usage) {
      const u = s.usage;
      h +=
        '<div class="tokens">' +
        tokRow("Input", u.input) +
        tokRow("Output", u.output) +
        tokRow("Cache write", u.cacheCreate) +
        tokRow("Cache read", u.cacheRead) +
        "</div>";
      if (typeof s.totalInput === "number" || typeof s.totalOutput === "number") {
        h +=
          '<div class="sub">context totals: ' +
          fmtInt(s.totalInput) +
          " in / " +
          fmtInt(s.totalOutput) +
          " out" +
          (s.ctxSize ? " · window " + fmtInt(s.ctxSize) : "") +
          "</div>";
      }
    } else {
      h += '<div class="sub">token usage pending (null after /compact or before first API call)</div>';
    }
    h += "</div>";
    return h;
  }

  function sessionRow(s) {
    const cls = s.stale ? "srow stale" : s.active ? "srow" : "srow stale";
    const ctx = typeof s.ctxPct === "number" ? Math.round(s.ctxPct) + "%" : "—";
    return (
      '<div class="' +
      cls +
      '">' +
      '<span class="s-model">' +
      esc(s.model || "—") +
      "</span>" +
      '<span class="s-id">' +
      esc((s.sessionName || s.id).slice(0, 20)) +
      "</span>" +
      '<span class="s-cost">' +
      fmtCost(s.cost || 0) +
      "</span>" +
      '<span class="s-ctx">' +
      ctx +
      "</span>" +
      '<span class="s-age">' +
      fmtAge(s.ageMs) +
      "</span>" +
      "</div>"
    );
  }

  function emptyState() {
    return (
      '<div class="card"><div class="card-h">No usage data yet</div>' +
      '<div class="sub">Install the status-line bridge, then use Claude Code. Data flows while a session is active.</div>' +
      '<div class="row" style="margin-top:8px"><button data-cmd="ccUsage.setup">Set up status-line bridge</button></div></div>'
    );
  }

  function render() {
    const app = document.getElementById("app");
    if (!app) return;
    const now = Date.now();

    if (!state || !state.sessions || state.sessions.length === 0) {
      document.body.classList.remove("stale");
      app.innerHTML = emptyState();
      wire();
      return;
    }

    const sessions = state.sessions.map(function (s) {
      const ageMs = Math.max(0, now - s.receivedAt);
      return Object.assign({}, s, {
        ageMs: ageMs,
        stale: ageMs > state.staleMs,
        active: ageMs <= state.activeWindowMs,
      });
    });
    const active = sessions.filter(function (s) {
      return s.active;
    });
    const sorted = sessions.slice().sort(function (a, b) {
      return a.ageMs - b.ageMs;
    });
    const freshest = sorted[0];
    const overallStale = !freshest || freshest.ageMs > state.staleMs;
    const cost = active.reduce(function (sum, s) {
      return sum + (typeof s.cost === "number" ? s.cost : 0);
    }, 0);

    document.body.classList.toggle("stale", overallStale);

    let html = "";
    if (overallStale) {
      html +=
        '<div class="banner">No active session — last values shown. Countdown still live.</div>';
    }

    const rate = state.rate || {};
    html += rateCard("5-hour limit", rate.fiveHour, now, true);
    html += rateCard("7-day limit", rate.sevenDay, now, false);

    html +=
      '<div class="card"><div class="card-h">Cost <span class="tag">API-equivalent</span></div>' +
      '<div class="big">' +
      fmtCost(cost) +
      "</div>" +
      '<div class="sub">across ' +
      active.length +
      " active session" +
      (active.length === 1 ? "" : "s") +
      " · not billed on Pro/Max</div></div>";

    html += sessionDetail(freshest);

    html +=
      '<div class="card"><div class="card-h">Sessions (' +
      sessions.length +
      ")</div>" +
      '<div class="srow head"><span>Model</span><span>Session</span><span class="s-cost">Cost</span><span class="s-ctx">Ctx</span><span class="s-age">Updated</span></div>' +
      sorted.map(sessionRow).join("") +
      "</div>";

    html +=
      '<div class="footer"><a href="#" data-cmd="ccUsage.openSessionsFolder">Open sessions folder</a> · ' +
      '<a href="#" data-cmd="ccUsage.setup">Re-run setup</a></div>';

    app.innerHTML = html;
    wire();
  }

  function wire() {
    const els = document.querySelectorAll("[data-cmd]");
    for (let i = 0; i < els.length; i++) {
      els[i].addEventListener("click", function (ev) {
        ev.preventDefault();
        vscode.postMessage({ type: "command", command: this.getAttribute("data-cmd") });
      });
    }
  }

  window.addEventListener("message", function (e) {
    const d = e.data;
    if (d && d.type === "state") {
      state = d.dto;
      render();
    }
  });

  setInterval(function () {
    if (state) render();
  }, 1000);

  vscode.postMessage({ type: "ready" });
  render();
})();
