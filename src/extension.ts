/**
 * extension.ts — wires the session store to the status-bar item and registers
 * commands. This is the thin vertical slice: bridge -> per-session files ->
 * watcher -> status-bar item (5-hour % + aggregated cost). The full sidebar
 * dashboard is layered on next.
 */

import * as vscode from "vscode";
import { SessionStore, defaultSessionsDir } from "./sessions";
import { StatusBarController } from "./statusBar";
import { DashboardProvider } from "./dashboard";
import { AggregateOptions } from "./model";
import { runSetup, isInstalled } from "./setup";
import { CompactNotifier, runCompact } from "./compact";

function readOptions(): AggregateOptions {
  const cfg = vscode.workspace.getConfiguration("ccUsage");
  const staleSeconds = cfg.get<number>("staleSeconds", 60);
  const activeWindowMinutes = cfg.get<number>("activeWindowMinutes", 30);
  const compactThreshold = cfg.get<number>("compactThresholdPercent", 50);
  return {
    staleMs: Math.max(5, staleSeconds) * 1000,
    activeWindowMs: Math.max(1, activeWindowMinutes) * 60 * 1000,
    compactThresholdPct: Math.min(100, Math.max(1, compactThreshold)),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  let opts = readOptions();

  const store = new SessionStore(defaultSessionsDir(), opts.staleMs);
  const statusBar = new StatusBarController(opts);
  const dashboard = new DashboardProvider(context.extensionUri, opts);
  const compact = new CompactNotifier(opts.compactThresholdPct);

  store.on("change", (sessions) => {
    statusBar.update(sessions);
    dashboard.update(sessions);
    compact.update(sessions, opts.staleMs);
  });
  store.start();

  context.subscriptions.push(
    new vscode.Disposable(() => store.dispose()),
    statusBar,
    vscode.window.registerWebviewViewProvider(DashboardProvider.viewType, dashboard, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("ccUsage.setup", () => runSetup(context)),
    vscode.commands.registerCommand("ccUsage.openSessionsFolder", async () => {
      const uri = vscode.Uri.file(defaultSessionsDir());
      await vscode.commands.executeCommand("revealFileInOS", uri);
    }),
    vscode.commands.registerCommand("ccUsage.focusDashboard", async () => {
      await vscode.commands.executeCommand("ccUsage.dashboard.focus");
    }),
    vscode.commands.registerCommand("ccUsage.compactNow", () =>
      runCompact("terminal")
    ),
    vscode.commands.registerCommand("ccUsage.copyCompactCommand", () =>
      runCompact("clipboard")
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ccUsage")) {
        opts = readOptions();
        store.setStaleMs(opts.staleMs);
        statusBar.setOptions(opts);
        dashboard.setOptions(opts);
        compact.setThreshold(opts.compactThresholdPct);
      }
    })
  );

  // First-run nudge: if the bridge isn't wired into settings.json yet, offer to
  // set it up (once — we don't nag).
  if (!isInstalled() && !context.globalState.get("ccUsage.setupDismissed")) {
    void vscode.window
      .showInformationMessage(
        "Claude Code Usage: finish setup to start streaming live usage from Claude Code.",
        "Set up now",
        "Later"
      )
      .then((choice) => {
        if (choice === "Set up now") {
          void runSetup(context);
        } else if (choice === "Later") {
          void context.globalState.update("ccUsage.setupDismissed", true);
        }
      });
  }
}

export function deactivate(): void {
  /* disposables handle teardown */
}
