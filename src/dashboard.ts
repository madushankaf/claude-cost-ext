/**
 * dashboard.ts — the sidebar webview view.
 *
 * Builds a serializable snapshot from the current sessions and posts it to the
 * webview client (media/dashboard.js), which renders and ticks locally. The
 * client also posts {type:'ready'} on load (we reply with a snapshot) and
 * {type:'command', command} to run extension commands (setup, open folder).
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  SessionInfo,
  AggregateOptions,
  aggregate,
  StatusLinePayload,
  ContextWindow,
} from "./model";

export class DashboardProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ccUsage.dashboard";

  private view?: vscode.WebviewView;
  private sessions: SessionInfo[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private opts: AggregateOptions
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => {
      if (!msg) return;
      if (msg.type === "ready") {
        this.post();
      } else if (msg.type === "command" && typeof msg.command === "string") {
        void vscode.commands.executeCommand(msg.command);
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.post();
    });
    this.post();
  }

  setOptions(opts: AggregateOptions): void {
    this.opts = opts;
    this.post();
  }

  update(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    this.post();
  }

  private post(): void {
    if (!this.view) return;
    const now = Date.now();
    const agg = aggregate(this.sessions, now, this.opts);

    const dto = {
      now,
      staleMs: this.opts.staleMs,
      activeWindowMs: this.opts.activeWindowMs,
      rate: {
        fiveHour: agg.fiveHour
          ? {
              pct: typeof agg.fiveHour.used_percentage === "number" ? agg.fiveHour.used_percentage : null,
              resetsAt: agg.fiveHour.resets_at ?? null,
            }
          : null,
        sevenDay: agg.sevenDay
          ? {
              pct: typeof agg.sevenDay.used_percentage === "number" ? agg.sevenDay.used_percentage : null,
              resetsAt: agg.sevenDay.resets_at ?? null,
            }
          : null,
        fromSessionId: agg.rateFromSessionId ?? null,
      },
      sessions: this.sessions.map((s) => {
        const p = (s.payload || {}) as StatusLinePayload;
        const cw = (p.context_window || {}) as ContextWindow;
        const cu = cw.current_usage || null;
        const cost = p.cost?.total_cost_usd;
        return {
          id: s.id,
          receivedAt: s.receivedAt,
          model: p.model?.display_name ?? null,
          sessionName: p.session_name ?? null,
          cwd: p.workspace?.current_dir ?? p.cwd ?? null,
          cost: typeof cost === "number" ? cost : null,
          ctxPct: typeof cw.used_percentage === "number" ? cw.used_percentage : null,
          ctxSize: typeof cw.context_window_size === "number" ? cw.context_window_size : null,
          totalInput: typeof cw.total_input_tokens === "number" ? cw.total_input_tokens : null,
          totalOutput: typeof cw.total_output_tokens === "number" ? cw.total_output_tokens : null,
          usage: cu
            ? {
                input: cu.input_tokens ?? 0,
                output: cu.output_tokens ?? 0,
                cacheCreate: cu.cache_creation_input_tokens ?? 0,
                cacheRead: cu.cache_read_input_tokens ?? 0,
              }
            : null,
        };
      }),
    };

    void this.view.webview.postMessage({ type: "state", dto });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "dashboard.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "dashboard.css")
    );
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Claude Code Usage</title>
</head>
<body>
  <div id="app"><div class="card"><div class="sub">Loading…</div></div></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
