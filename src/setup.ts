/**
 * setup.ts — first-run setup UX.
 *
 * Installs the bridge script into ~/.claude/cc-usage/ and wires it into
 * ~/.claude/settings.json as the `statusLine` command. If a custom status line
 * already exists, we WRAP it (pass it via --wrap) instead of overwriting, so
 * the user's existing output is preserved. A manual copy-paste fallback is
 * always offered.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function claudeDir(): string {
  return path.join(os.homedir(), ".claude");
}
export function bridgeTargetPath(): string {
  return path.join(claudeDir(), "cc-usage", "cc-usage-bridge.js");
}
export function settingsPath(): string {
  return path.join(claudeDir(), "settings.json");
}

/** Shell command to run the bridge, optionally wrapping a pre-existing one. */
export function bridgeCommand(wrapOriginal?: string): string {
  let cmd = `node "${bridgeTargetPath()}"`;
  if (wrapOriginal && wrapOriginal.trim()) {
    cmd += ` --wrap "${wrapOriginal.replace(/(["\\$`])/g, "\\$1")}"`;
  }
  return cmd;
}

/** Copy the bundled bridge script to ~/.claude/cc-usage/cc-usage-bridge.js. */
export function installBridge(context: vscode.ExtensionContext): string {
  const src = context.asAbsolutePath(path.join("bridge", "cc-usage-bridge.js"));
  const dst = bridgeTargetPath();
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  try {
    fs.chmodSync(dst, 0o755);
  } catch {
    /* non-fatal */
  }
  return dst;
}

interface StatusLineEntry {
  type?: string;
  command?: string;
  [k: string]: unknown;
}

function readSettings(): { obj: Record<string, unknown> | null; parseError: boolean; exists: boolean } {
  const p = settingsPath();
  if (!fs.existsSync(p)) return { obj: {}, parseError: false, exists: false };
  try {
    const txt = fs.readFileSync(p, "utf8");
    const obj = txt.trim() ? JSON.parse(txt) : {};
    return { obj, parseError: false, exists: true };
  } catch {
    return { obj: null, parseError: true, exists: true };
  }
}

/** True when settings.json already points statusLine at our bridge. */
export function isWiredUp(): boolean {
  const { obj } = readSettings();
  const sl = (obj?.["statusLine"] as StatusLineEntry | undefined) ?? undefined;
  const cmd = sl?.command;
  return typeof cmd === "string" && cmd.includes("cc-usage-bridge");
}

export function isInstalled(): boolean {
  return fs.existsSync(bridgeTargetPath()) && isWiredUp();
}

function snippetFor(command: string): string {
  return JSON.stringify({ statusLine: { type: "command", command } }, null, 2);
}

async function manualFallback(command: string): Promise<void> {
  const snippet = snippetFor(command);
  await vscode.env.clipboard.writeText(snippet);
  const doc = await vscode.workspace.openTextDocument({
    language: "json",
    content:
      `// Paste the "statusLine" entry below into ${settingsPath()}\n` +
      `// (merge it with your existing settings — this has been copied to your clipboard).\n` +
      snippet +
      "\n",
  });
  await vscode.window.showTextDocument(doc, { preview: false });
  void vscode.window.showInformationMessage(
    "Status-line snippet copied to your clipboard. Merge it into ~/.claude/settings.json, then restart Claude Code."
  );
}

export async function runSetup(context: vscode.ExtensionContext): Promise<void> {
  // 1. Always install/refresh the bridge script first.
  let bridge: string;
  try {
    bridge = installBridge(context);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Claude Code Usage: could not write the bridge script (${String(e)}).`
    );
    return;
  }

  // 2. Inspect existing settings to decide add-vs-wrap.
  const { obj, parseError, exists } = readSettings();
  const existing = (obj?.["statusLine"] as StatusLineEntry | undefined) ?? undefined;
  const existingCmd = typeof existing?.command === "string" ? existing.command : undefined;

  if (existingCmd && existingCmd.includes("cc-usage-bridge")) {
    void vscode.window.showInformationMessage(
      "Claude Code Usage: bridge refreshed — your status line is already wired up. Restart Claude Code if it isn't streaming yet."
    );
    return;
  }

  const willWrap = !!existingCmd;
  const command = bridgeCommand(existingCmd);

  // If we can't safely parse settings.json, go straight to manual paste.
  if (parseError) {
    void vscode.window.showWarningMessage(
      "Claude Code Usage: ~/.claude/settings.json isn't plain JSON I can edit safely. I'll give you a snippet to paste instead."
    );
    await manualFallback(command);
    return;
  }

  const detail = willWrap
    ? `You already have a custom status line. I'll wrap it so it keeps working and add usage capture on top:\n\n${command}`
    : `I'll add this status line to ${settingsPath()}:\n\n${command}`;

  const choice = await vscode.window.showInformationMessage(
    "Set up the Claude Code Usage status-line bridge?",
    { modal: true, detail },
    "Add automatically",
    "Copy snippet instead"
  );

  if (choice === "Copy snippet instead") {
    await manualFallback(command);
    return;
  }
  if (choice !== "Add automatically") {
    return; // cancelled
  }

  // 3. Write settings.json (back it up first).
  try {
    const settings = (obj as Record<string, unknown>) ?? {};
    const nextStatusLine: StatusLineEntry = {
      ...(existing && typeof existing === "object" ? existing : {}),
      type: "command",
      command,
    };
    settings["statusLine"] = nextStatusLine;

    fs.mkdirSync(claudeDir(), { recursive: true });
    if (exists) {
      try {
        fs.copyFileSync(settingsPath(), settingsPath() + ".cc-usage.bak");
      } catch {
        /* non-fatal */
      }
    }
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n");
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Claude Code Usage: failed to update settings.json (${String(e)}). Falling back to manual paste.`
    );
    await manualFallback(command);
    return;
  }

  const action = await vscode.window.showInformationMessage(
    willWrap
      ? "Wrapped your existing status line. Restart Claude Code and accept the one-time status-line trust prompt to start streaming."
      : "Status line configured. Restart Claude Code and accept the one-time status-line trust prompt to start streaming.",
    "Open settings.json"
  );
  if (action === "Open settings.json") {
    const doc = await vscode.workspace.openTextDocument(settingsPath());
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}
