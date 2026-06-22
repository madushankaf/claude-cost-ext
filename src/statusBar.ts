/**
 * statusBar.ts — the bottom-right status-bar item.
 *
 * Re-renders once a second so the 5-hour countdown ticks and staleness greys
 * out even when no new file events arrive. Clicking the item runs
 * `ccUsage.focusDashboard`.
 */

import * as vscode from "vscode";
import {
  SessionInfo,
  AggregateOptions,
  aggregate,
  formatStatusBarText,
  buildTooltipMarkdown,
} from "./model";

export class StatusBarController {
  private item: vscode.StatusBarItem;
  private sessions: SessionInfo[] = [];
  private timer: NodeJS.Timeout;

  constructor(private opts: AggregateOptions) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = "ccUsage.focusDashboard";
    this.item.name = "Claude Code Usage";
    this.item.show();

    this.timer = setInterval(() => this.render(), 1000);
    this.render();
  }

  setOptions(opts: AggregateOptions): void {
    this.opts = opts;
    this.render();
  }

  update(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    this.render();
  }

  private render(): void {
    const now = Date.now();
    // Recompute age/staleness at render time so the readout stays live between
    // file events.
    const sess = this.sessions.map((s) => ({
      ...s,
      ageMs: Math.max(0, now - s.receivedAt),
      stale: now - s.receivedAt > this.opts.staleMs,
    }));

    const agg = aggregate(sess, now, this.opts);

    this.item.text = formatStatusBarText(agg, now);

    const md = new vscode.MarkdownString(buildTooltipMarkdown(agg, sess, now));
    md.supportHtml = true;
    md.isTrusted = true;
    this.item.tooltip = md;

    // Grey out when stale; the countdown inside the text still advances.
    this.item.color = agg.stale
      ? new vscode.ThemeColor("disabledForeground")
      : undefined;

    const five = agg.fiveHour?.used_percentage;
    if (!agg.stale && typeof five === "number" && five >= 90) {
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
    } else {
      this.item.backgroundColor = undefined;
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item.dispose();
  }
}
