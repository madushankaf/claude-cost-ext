# Claude Code Usage

Live Claude Code usage in your editor — the **5-hour rate limit** with a live
countdown, plus cost, tokens, and context fill — in a status-bar item and a
sidebar dashboard.

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/madushankaf.cc-usage?label=Marketplace&color=1A1916)](https://marketplace.visualstudio.com/items?itemName=madushankaf.cc-usage)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Data comes from Claude Code's **status line**, not from parsing transcripts. A
tiny Node bridge reads the status-line JSON, writes it to a per-session file, and
still prints your normal status line — so nothing about your terminal changes.

## Features

- **Status-bar item** — `5h NN% (countdown) · $cost`. Greys out when stale, warns
  at ≥90% of the 5-hour limit, opens the dashboard on click.
- **Sidebar dashboard** — 5-hour and 7-day limits, API-equivalent cost, context
  fill, token breakdown, and all sessions with "updated Ns ago". The countdown
  ticks every second.
- **Compaction nudge** — when context crosses a threshold (default 50%), shows a
  `⚠ /compact` hint and a one-time notification to **Compact now**, **Copy**, or
  **Don't show again**.

## Install

1. Install **Claude Code Usage** from the
   [Marketplace](https://marketplace.visualstudio.com/items?itemName=madushankaf.cc-usage),
   or run `code --install-extension madushankaf.cc-usage`.
2. Run **“Claude Code Usage: Set Up Status-Line Bridge”** from the Command
   Palette. It installs the bridge and wires `statusLine` in `~/.claude/settings.json`
   (wrapping any existing one).
3. **Restart Claude Code** and accept the one-time status-line trust prompt.
4. Open the **Claude Code Usage** icon in the activity bar for the dashboard.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `ccUsage.staleSeconds` | `60` | Grey out the readout after this many seconds without an update. |
| `ccUsage.activeWindowMinutes` | `30` | Sessions this recent count as active for cost aggregation. |
| `ccUsage.compactThresholdPercent` | `50` | Context fill at which the `/compact` hint triggers. |
| `ccUsage.compactNotification` | `true` | Pop the notification on crossing (edge-triggered). |
| `ccUsage.compactInstructions` | `""` | Preservation rules appended to `/compact`. |

## Notes

- **Cost is API-equivalent** — an estimate of what the API would cost. On Pro/Max
  you are not billed it.
- **Context % is indicative** and can read above 100% right after auto-compact;
  trust the 5-hour number for limits.
- **Rate limits** only appear for Pro/Max after the first API response.
- **Multi-session** — the limit is read from the freshest session; cost is summed
  across active sessions.

## Develop

```sh
npm install
npm run compile      # build to out/
npm test             # run tests
npx @vscode/vsce package   # build a .vsix
```

Open the folder in VS Code and press `F5` to launch the Extension Development Host.

## License

[MIT](./LICENSE)
