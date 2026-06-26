"use strict";
/**
 * End-to-end pipeline test (plain Node, no VS Code needed).
 *
 *   1. Feeds mock status-line JSON through the bridge and checks the per-session
 *      file is written and the passthrough status line is printed.
 *   2. Exercises the gotchas: null current_usage / absent rate_limits, --wrap
 *      preserving an existing status line, and malformed JSON not crashing.
 *   3. Loads the compiled model + session store and checks multi-session
 *      aggregation (shared limit read once, cost summed) and formatting.
 *
 * Run after `npm run compile`:  node test/test.js
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(ROOT, "bridge", "cc-usage-bridge.js");

let failures = 0;
let count = 0;
function ok(cond, msg) {
  count++;
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) failures++;
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function runBridge(input, dir, extraArgs = []) {
  return spawnSync("node", [BRIDGE, ...extraArgs], {
    input,
    encoding: "utf8",
    env: { ...process.env, CC_USAGE_SESSIONS_DIR: dir },
  });
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-usage-test-"));
  const dir = path.join(tmp, "sessions");
  fs.mkdirSync(dir, { recursive: true });

  const active = fs.readFileSync(path.join(__dirname, "mock-active.json"), "utf8");
  const nullUsage = fs.readFileSync(path.join(__dirname, "mock-null-usage.json"), "utf8");
  const activeObj = JSON.parse(active);

  console.log("\nBridge: writes per-session file + prints summary");
  const r1 = runBridge(active, dir);
  ok(r1.status === 0, "exit 0");
  ok(r1.stdout.trim().length > 0, "prints a status line");
  ok(/Opus/.test(r1.stdout) && /5h\s*24%/.test(r1.stdout), "summary shows model + 5h%");
  const f1 = path.join(dir, activeObj.session_id + ".json");
  ok(fs.existsSync(f1), "session file created at <session_id>.json");
  const rec1 = JSON.parse(fs.readFileSync(f1, "utf8"));
  ok(typeof rec1.received_at === "number", "record carries received_at");
  ok(
    rec1.payload && rec1.payload.cost.total_cost_usd === activeObj.cost.total_cost_usd,
    "raw payload preserved verbatim"
  );

  console.log("\nBridge: null current_usage / absent rate_limits (post-/compact)");
  const r2 = runBridge(nullUsage, dir);
  ok(r2.status === 0, "exit 0 on null usage");
  ok(r2.stdout.trim().length > 0, "still prints a line");

  console.log("\nBridge: --wrap preserves an existing status line");
  const r3 = runBridge(active, dir, ["--wrap", 'printf "CUSTOM-LINE"']);
  ok(r3.stdout.trim() === "CUSTOM-LINE", "wrapped command output is shown verbatim");
  ok(fs.existsSync(f1), "session file still updated while wrapping");

  console.log("\nBridge: malformed JSON does not crash");
  const r4 = runBridge("{not json", dir);
  ok(r4.status === 0, "exit 0 on bad json");
  ok(/cc-usage/.test(r4.stdout), "prints a safe fallback line");

  // ---- compiled model + store ----
  const model = require(path.join(ROOT, "out", "model.js"));
  const { SessionStore } = require(path.join(ROOT, "out", "sessions.js"));

  console.log("\nAggregation: multi-session, shared limit read once");
  // Use a fresh dir so the malformed-JSON "unknown.json" above doesn't pollute counts.
  const dir2 = path.join(tmp, "sessions2");
  fs.mkdirSync(dir2, { recursive: true });
  const older = JSON.parse(active);
  older.session_id = "99999999-older-session";
  older.cost.total_cost_usd = 1.0;
  older.rate_limits.five_hour.used_percentage = 50; // should be ignored (not freshest)
  runBridge(JSON.stringify(older), dir2);
  sleepSync(30);
  runBridge(active, dir2); // rewrite -> freshest

  const store = new SessionStore(dir2, 60000);
  store.refresh();
  const now = Date.now();
  const opts = { activeWindowMs: 30 * 60 * 1000, staleMs: 60 * 1000 };
  const agg = model.aggregate(store.sessions, now, opts);

  ok(agg.totalCount === 2, "two session files discovered");
  ok(agg.activeCount === 2, "both counted active");
  ok(Math.abs(agg.costUsd - (0.4213 + 1.0)) < 1e-9, "cost summed across active sessions");
  ok(agg.fiveHour && agg.fiveHour.used_percentage === 23.5, "5h% taken from freshest session");
  ok(agg.rateFromSessionId === activeObj.session_id, "shared limit read once, from freshest");
  ok(agg.stale === false, "not stale right after writing");

  console.log("\nFormatting");
  const text = model.formatStatusBarText(agg, now);
  ok(/5h\s*24%/.test(text), "status text shows 5h 24% (rounded)");
  ok(text.includes("$1.42"), "status text shows summed cost");
  ok(text.includes("2 sess"), "status text shows session count");

  // Second-align "now" so countdown assertions aren't off-by-one from sub-second flooring.
  const nowS = Math.floor(now / 1000) * 1000;
  const baseSec = nowS / 1000;
  ok(model.formatCountdown(baseSec + 2 * 3600 + 14 * 60, nowS) === "2h 14m", "countdown h/m");
  ok(/^\d+m \d{2}s$/.test(model.formatCountdown(baseSec + 5 * 60 + 9, nowS)), "countdown m/s");
  ok(model.formatCountdown(baseSec + 45, nowS) === "45s", "countdown seconds");
  ok(model.formatCountdown(baseSec - 10, nowS) === "now", "countdown past = now");

  console.log("\nEdge cases");
  ok(model.parseSessionRecord("{not json") === null, "parseSessionRecord rejects garbage");
  const si = model.toSessionInfo("x", { received_at: now - 120000, payload: null }, now, 60000);
  ok(si.stale === true, "session older than staleMs is stale");
  const tip = model.buildTooltipMarkdown(agg, store.sessions, now);
  ok(/API-equivalent/.test(tip) && /Opus/.test(tip), "tooltip includes API-equivalent label + model");

  console.log("\nCompaction nudge");
  ok(model.compactCommand("") === "/compact", "compactCommand: empty -> plain /compact");
  ok(
    model.compactCommand("keep the auth refactor") === "/compact keep the auth refactor",
    "compactCommand: appends instructions"
  );
  ok(model.compactCommand("  x  ") === "/compact x", "compactCommand: trims instructions");

  const sess = (id, ctx, ageMs = 0) => ({
    id,
    receivedAt: now - ageMs,
    payload: { context_window: { used_percentage: ctx } },
  });
  const staleMs = 60000;

  // Edge-trigger: fires once on the way up, not again while still over.
  let st = {};
  let r = model.detectCompactCrossings([sess("a", 55)], st, 50, staleMs, now);
  ok(r.fired.length === 1 && r.fired[0] === "a", "crossing up fires once");
  st = r.next;
  r = model.detectCompactCrossings([sess("a", 70)], st, 50, staleMs, now);
  ok(r.fired.length === 0, "still over -> no re-fire");
  st = r.next;
  // Drops below (e.g. after /compact), then crosses again -> fires again.
  r = model.detectCompactCrossings([sess("a", 20)], st, 50, staleMs, now);
  ok(r.fired.length === 0 && r.next.a === false, "drop below clears the over-flag");
  st = r.next;
  r = model.detectCompactCrossings([sess("a", 60)], st, 50, staleMs, now);
  ok(r.fired.length === 1, "re-crossing fires again");

  // Stale session never fires.
  r = model.detectCompactCrossings([sess("b", 90, staleMs + 5000)], {}, 50, staleMs, now);
  ok(r.fired.length === 0 && r.next.b === false, "stale session does not fire");

  // aggregate() flags compactSuggested off the freshest session vs threshold.
  const aggOpts = { staleMs, activeWindowMs: 1800000, compactThresholdPct: 50 };
  const over = model.aggregate([sess("a", 64)], now, aggOpts);
  ok(over.compactSuggested === true && Math.round(over.freshestCtxPct) === 64, "aggregate suggests compact when over");
  const under = model.aggregate([sess("a", 30)], now, aggOpts);
  ok(under.compactSuggested === false, "aggregate does not suggest when under");
  ok(
    model.formatStatusBarText(over, now).includes("/compact"),
    "status text shows /compact hint when suggested"
  );

  store.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${count - failures}/${count} checks passed.`);
  if (failures) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
  console.log("ALL PASS");
}

main();
