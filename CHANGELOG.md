# Changelog

All notable changes to the **Claude Code Usage** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-06-26

### Added
- Status-bar item (bottom-right): `5h NN% (countdown) · $cost`, greys out when
  stale, turns to a warning background at ≥90% of the 5-hour limit, and focuses
  the dashboard on click. Hover for a per-session table.
- Sidebar dashboard (activity-bar icon): 5-hour limit headline with progress bar
  and live countdown, 7-day limit, API-equivalent cost across active sessions,
  freshest session's context fill and token breakdown, and a list of all
  sessions with "updated Ns ago".
- Status-line bridge with one-command setup that installs the bridge and wires
  `statusLine` in `~/.claude/settings.json`, wrapping any existing status line.
- Compaction nudge: status-bar `⚠ /compact` hint plus an edge-triggered
  notification (Compact now / Copy / Don't show again) when a session's context
  fill crosses `ccUsage.compactThresholdPercent` (default 50%). Preservation
  rules from `ccUsage.compactInstructions` are appended to `/compact`. Commands:
  **Compact Now**, **Copy /compact Command**.
- Settings: `ccUsage.staleSeconds`, `ccUsage.activeWindowMinutes`,
  `ccUsage.compactThresholdPercent`, `ccUsage.compactNotification`,
  `ccUsage.compactInstructions`.
