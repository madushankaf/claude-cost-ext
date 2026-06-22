"use strict";
/**
 * Headless render test for the dashboard webview client (media/dashboard.js).
 * Loads the client into jsdom with a stubbed acquireVsCodeApi, posts a state
 * snapshot, and asserts the rendered DOM — countdown, aggregated cost, token
 * breakdown, >100% context handling, stale class/banner, command wiring, and
 * the empty state.
 *
 * Run after `npm install`:  node test/dashboard.test.js
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
let failures = 0;
let count = 0;
function ok(c, m) {
  count++;
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) failures++;
}

function makeDom() {
  const script = fs.readFileSync(path.join(ROOT, "media", "dashboard.js"), "utf8");
  const html =
    '<!DOCTYPE html><html><body><div id="app"></div><script>' + script + "</script></body></html>";
  const posted = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = function () {
        return {
          postMessage: function (m) {
            posted.push(m);
          },
          getState: function () {},
          setState: function () {},
        };
      };
    },
  });
  return { dom, posted };
}

function sendState(dom, dto) {
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "state", dto } }));
}

function main() {
  const now = Date.now();
  const base = Math.floor(now / 1000);
  const dto = {
    now,
    staleMs: 60000,
    activeWindowMs: 30 * 60 * 1000,
    rate: {
      fiveHour: { pct: 23.5, resetsAt: base + 2 * 3600 + 14 * 60 + 40 },
      sevenDay: { pct: 41.2, resetsAt: base + 3 * 86400 },
      fromSessionId: "s1",
    },
    sessions: [
      {
        id: "11111111-aaaa",
        receivedAt: now - 2000,
        model: "Opus",
        sessionName: "feature",
        cwd: "/x",
        cost: 0.4213,
        ctxPct: 24,
        ctxSize: 200000,
        totalInput: 48211,
        totalOutput: 1200,
        usage: { input: 8500, output: 1200, cacheCreate: 5000, cacheRead: 34711 },
      },
      {
        id: "22222222-bbbb",
        receivedAt: now - 5000,
        model: "Sonnet",
        sessionName: null,
        cwd: "/y",
        cost: 1.0,
        ctxPct: 118, // > 100 after auto-compact
        ctxSize: 200000,
        totalInput: 0,
        totalOutput: 0,
        usage: null, // null right after /compact
      },
    ],
  };

  console.log("\nDashboard render (jsdom)");
  const { dom, posted } = makeDom();
  ok(posted.some((m) => m && m.type === "ready"), "client posts 'ready' on load");

  sendState(dom, dto);
  const app = dom.window.document.getElementById("app");
  const h = app.innerHTML;

  ok(/5-hour limit/.test(h), "shows 5-hour limit card");
  ok(/24%/.test(h), "rounds 5h percent (23.5 -> 24)");
  ok(/resets in 2h 14m/.test(h), "shows live countdown from resets_at");
  ok(/7-day limit/.test(h), "shows 7-day card");
  ok(/API-equivalent/.test(h), "cost labeled API-equivalent");
  ok(/\$1\.42/.test(h), "aggregates cost across active sessions ($0.42 + $1.00)");
  ok(/not billed on Pro\/Max/.test(h), "notes not billed on Pro/Max");
  ok(/8,500/.test(h), "token breakdown: input grouped with thousands");
  ok(/34,711/.test(h), "token breakdown: cache read");
  ok(/Sessions \(2\)/.test(h), "lists both sessions");

  // Freshest session in the post-/compact (or pre-first-call) state: ctx > 100%
  // and current_usage null. The detail card reflects the freshest session.
  const dto3 = {
    now: Date.now(),
    staleMs: 60000,
    activeWindowMs: 30 * 60 * 1000,
    rate: dto.rate,
    sessions: [
      {
        id: "cccccccc-comp",
        receivedAt: Date.now() - 1000,
        model: "Opus",
        sessionName: null,
        cwd: "/z",
        cost: 0.1,
        ctxPct: 118,
        ctxSize: 200000,
        totalInput: 0,
        totalOutput: 0,
        usage: null,
      },
    ],
  };
  sendState(dom, dto3);
  const h3 = dom.window.document.getElementById("app").innerHTML;
  ok(/auto-compacted/.test(h3), "context > 100% flagged as auto-compacted (freshest session)");
  ok(/token usage pending/.test(h3), "null current_usage shows pending message (freshest session)");

  // Stale: push every session well past staleMs.
  const dto2 = JSON.parse(JSON.stringify(dto));
  dto2.now = Date.now();
  dto2.sessions.forEach((s) => {
    s.receivedAt = dto2.now - 5 * 60 * 1000;
  });
  sendState(dom, dto2);
  ok(dom.window.document.body.classList.contains("stale"), "adds 'stale' class when nothing is recent");
  ok(
    /Countdown still live/.test(dom.window.document.getElementById("app").innerHTML),
    "stale banner notes the countdown stays live"
  );

  // Command wiring.
  const link = dom.window.document.querySelector('[data-cmd="ccUsage.openSessionsFolder"]');
  ok(!!link, "footer exposes open-sessions-folder command");
  link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  ok(
    posted.some((m) => m && m.type === "command" && m.command === "ccUsage.openSessionsFolder"),
    "clicking a command link posts a command message"
  );

  // Empty state.
  sendState(dom, {
    now: Date.now(),
    staleMs: 60000,
    activeWindowMs: 1800000,
    rate: { fiveHour: null, sevenDay: null, fromSessionId: null },
    sessions: [],
  });
  ok(
    /No usage data yet/.test(dom.window.document.getElementById("app").innerHTML),
    "shows empty state when there are no sessions"
  );

  dom.window.close();

  console.log(`\n${count - failures}/${count} checks passed.`);
  if (failures) {
    console.log(failures + " FAILED");
    process.exit(1);
  }
  console.log("ALL PASS");
}

main();
