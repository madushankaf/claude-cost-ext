# Claude Code Usage (VS Code extension)

Live Claude Code usage in a bottom-right status-bar item (and, next, a sidebar
dashboard). Headline metric is the **5-hour rate limit** with a live countdown;
it also tracks API-equivalent cost, tokens, and context fill.

Data comes from Claude Code's **status line**, not from parsing transcripts. A
tiny Node bridge reads the status-line JSON on stdin, writes it to a per-session
file, and prints a normal status line so nothing about your terminal changes.

## How it works

```
Claude Code ──stdin JSON──▶ cc-usage-bridge.js ──▶ ~/.claude/cc-usage/sessions/<session_id>.json
                                   │
                                   └──▶ stdout (normal status line)

VS Code extension ──fs.watch──▶ sessions/*.json ──▶ status-bar item + sidebar dashboard
```

The bridge wraps (not replaces) any status line you already have, so your
existing output keeps showing.

## What's included

- **Status-bar item** (bottom-right): `5h NN% (countdown) · $cost`, greys out
  when stale, turns to a warning background at ≥90% of the 5-hour limit, and
  clicking it focuses the dashboard. Hover for a per-session table.
- **Sidebar dashboard** (activity-bar icon): the 5-hour limit headline with a
  progress bar and live countdown, the 7-day limit, API-equivalent cost across
  active sessions, the freshest session's context fill, its token breakdown
  (input / output / cache write / cache read), and a list of all sessions with
  "updated Ns ago". Re-renders every second so the countdown ticks even when no
  new data arrives; dims when stale.

## Setup

1. `npm install`
2. `npm run compile`
3. Open this folder in VS Code and press `F5` (Run Extension) to launch the
   Extension Development Host.
4. Run **“Claude Code Usage: Set Up Status-Line Bridge”** from the Command
   Palette (or accept the first-run prompt). It installs the bridge to
   `~/.claude/cc-usage/cc-usage-bridge.js` and wires `statusLine` in
   `~/.claude/settings.json` (wrapping any existing one). A copy-paste fallback
   is offered if it can't edit your settings safely.
5. **Restart Claude Code and accept the one-time status-line trust prompt.**
   Status-line scripts only run after you've accepted workspace trust.
6. Open the **Claude Code Usage** icon in the activity bar for the dashboard.
   The bottom-right status-bar item is always visible; click it to focus the
   dashboard.

## Notes & gotchas (by design)

- **Updated “Ns ago” + greyed when stale.** Data only flows while a Claude Code
  session is active. When nothing has updated recently the readout greys out —
  but the 5-hour countdown keeps ticking, because it's derived from the absolute
  `resets_at` timestamp.
- **Cost is API-equivalent.** `cost.total_cost_usd` is an estimate of what the
  API would cost. On Pro/Max you are **not** billed it.
- **Context % is indicative.** `used_percentage` can read above 100% right after
  auto-compact, so trust the 5-hour number for limits.
- **Quiet right after `/compact`.** `current_usage` is `null` before the first
  API call and again immediately after `/compact`; the UI handles this.
- **Rate limits need one API response.** `rate_limits` only appears for Pro/Max
  after the first API response in a session.
- **Multi-session.** Several terminals share one account-wide rate limit, so the
  limit is read once from the freshest session; cost is summed across active
  sessions.

## Configuration

- `ccUsage.staleSeconds` (default 60) — grey-out threshold.
- `ccUsage.activeWindowMinutes` (default 30) — sessions counted as active for
  cost aggregation.

## Develop

- `npm run compile` — type-check + build to `out/`.
- `npm run watch` — incremental build.
- `npm test` — compile, then run the pipeline/aggregation tests
  (`test/test.js`) and the headless dashboard render tests (`test/dashboard.test.js`).
