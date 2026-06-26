/**
 * compact.ts — the compaction nudge.
 *
 * Watches each session's context fill and pops a one-time toast when a session
 * crosses the configured threshold (edge-triggered via detectCompactCrossings,
 * so it won't spam — a session only re-fires after its context drops back down,
 * e.g. after a /compact). The toast and the palette commands deliver a
 * `/compact <ccUsage.compactInstructions>` command either into the active
 * terminal or onto the clipboard.
 *
 * The passive status-bar hint lives in model/statusBar; this module owns only
 * the active notification and the compact actions.
 */

import * as vscode from "vscode";
import { SessionInfo, detectCompactCrossings, compactCommand } from "./model";

function instructions(): string {
  return vscode.workspace
    .getConfiguration("ccUsage")
    .get<string>("compactInstructions", "");
}

/** Deliver `/compact <instructions>` to the active terminal or the clipboard. */
export async function runCompact(target: "terminal" | "clipboard"): Promise<void> {
  const cmd = compactCommand(instructions());
  if (target === "terminal") {
    const term = vscode.window.activeTerminal;
    if (term) {
      term.show(true);
      term.sendText(cmd, true); // newline -> runs it in the focused terminal
      return;
    }
    await vscode.env.clipboard.writeText(cmd);
    void vscode.window.showInformationMessage(
      `No active terminal — copied "${cmd}" to the clipboard instead.`
    );
    return;
  }
  await vscode.env.clipboard.writeText(cmd);
  void vscode.window.showInformationMessage(`Copied "${cmd}" to the clipboard.`);
}

export class CompactNotifier {
  private over: Record<string, boolean> = {};

  constructor(private thresholdPct: number) {}

  setThreshold(pct: number): void {
    this.thresholdPct = pct;
  }

  update(sessions: SessionInfo[], staleMs: number): void {
    const now = Date.now();
    const { fired, next } = detectCompactCrossings(
      sessions,
      this.over,
      this.thresholdPct,
      staleMs,
      now
    );
    this.over = next;
    if (!fired.length || !this.enabled()) return;
    this.showNudge(sessions, fired);
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration("ccUsage")
      .get<boolean>("compactNotification", true);
  }

  private showNudge(sessions: SessionInfo[], firedIds: string[]): void {
    const firedSet = new Set(firedIds);
    const fresh = sessions
      .filter((s) => firedSet.has(s.id))
      .sort((a, b) => b.receivedAt - a.receivedAt)[0];
    const ctx = fresh?.payload?.context_window?.used_percentage;
    const pctText = typeof ctx === "number" ? `${Math.round(ctx)}% full` : "filling up";
    const msg = `Claude Code context is ${pctText}. Consider running /compact.`;

    void vscode.window
      .showWarningMessage(msg, "Compact now", "Copy", "Don't show again")
      .then((choice) => {
        if (choice === "Compact now") void runCompact("terminal");
        else if (choice === "Copy") void runCompact("clipboard");
        else if (choice === "Don't show again") {
          void vscode.workspace
            .getConfiguration("ccUsage")
            .update(
              "compactNotification",
              false,
              vscode.ConfigurationTarget.Global
            );
          void vscode.window.showInformationMessage(
            "Compaction notifications off. The status-bar hint still appears; re-enable via the ccUsage.compactNotification setting."
          );
        }
      });
  }
}
