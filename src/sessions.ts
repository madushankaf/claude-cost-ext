/**
 * sessions.ts — watches ~/.claude/cc-usage/sessions and emits the current set
 * of sessions. Node-only (fs/os/path/events), no `vscode` import, so it can be
 * exercised in plain Node tests.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import { parseSessionRecord, toSessionInfo, SessionInfo } from "./model";

export function defaultSessionsDir(): string {
  if (process.env.CC_USAGE_SESSIONS_DIR) {
    return process.env.CC_USAGE_SESSIONS_DIR;
  }
  const home = process.env.CC_USAGE_HOME || os.homedir();
  return path.join(home, ".claude", "cc-usage", "sessions");
}

export class SessionStore extends EventEmitter {
  private watcher?: fs.FSWatcher;
  private debounceTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  sessions: SessionInfo[] = [];

  constructor(
    private readonly dir: string,
    private staleMs: number,
    private readonly pollMs = 1500
  ) {
    super();
  }

  setStaleMs(ms: number): void {
    this.staleMs = ms;
  }

  start(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* ignore */
    }
    this.refresh();

    // Immediate updates via fs.watch (FSEvents on macOS), plus a slow poll as a
    // safety net in case watch events are missed (e.g. some network filesystems).
    try {
      this.watcher = fs.watch(this.dir, () => this.scheduleRefresh());
    } catch {
      /* rely on polling */
    }
    this.pollTimer = setInterval(() => this.refresh(), this.pollMs);
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.refresh(), 150);
  }

  refresh(): void {
    const now = Date.now();
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("."));
    } catch {
      files = [];
    }

    const next: SessionInfo[] = [];
    for (const f of files) {
      const id = f.replace(/\.json$/, "");
      try {
        const txt = fs.readFileSync(path.join(this.dir, f), "utf8");
        const rec = parseSessionRecord(txt);
        if (rec) next.push(toSessionInfo(id, rec, now, this.staleMs));
      } catch {
        // partial/unreadable file — skip; atomic writes make this rare
      }
    }

    this.sessions = next;
    this.emit("change", next);
  }

  dispose(): void {
    if (this.watcher) this.watcher.close();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.removeAllListeners();
  }
}
