#!/usr/bin/env node
/**
 * cc-usage-bridge.js
 * Claude Code status-line bridge for the "Claude Code Usage" VS Code extension.
 *
 * Claude Code pipes status-line JSON to this script on stdin. The script:
 *   1. Persists the payload to ~/.claude/cc-usage/sessions/<session_id>.json
 *      (atomic write), wrapped with a `received_at` timestamp so the extension
 *      can tell how fresh each session is.
 *   2. Prints a short status line to stdout so it still works as a normal
 *      Claude Code status line.
 *
 * Optionally wraps an existing status-line command:  --wrap "<command>"
 * The original command receives the SAME stdin and its stdout is what gets
 * shown, so your existing status line is preserved while we capture data.
 *
 * Design rules:
 *   - Zero dependencies.
 *   - Never throw on the happy path: a failure to persist must not blank out
 *     your status line. All persistence is best-effort inside try/catch.
 *   - Atomic writes (temp file + rename) so the extension never reads a
 *     half-written file.
 *
 * Env overrides (mainly for testing):
 *   CC_USAGE_SESSIONS_DIR  full path to the sessions directory
 *   CC_USAGE_HOME          home dir used to derive ~/.claude/cc-usage/sessions
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function sessionsDir() {
  if (process.env.CC_USAGE_SESSIONS_DIR) {
    return process.env.CC_USAGE_SESSIONS_DIR;
  }
  const home = process.env.CC_USAGE_HOME || os.homedir();
  return path.join(home, '.claude', 'cc-usage', 'sessions');
}

function parseArgs(argv) {
  const out = { wrap: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wrap') {
      out.wrap = argv[i + 1] || null;
      i++;
    }
  }
  return out;
}

function readStdin() {
  // Claude Code always pipes JSON to fd 0; a synchronous read to EOF is simplest.
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
}

function persist(data) {
  try {
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const id = data && data.session_id ? safeName(data.session_id) : 'unknown';
    const file = path.join(dir, id + '.json');
    const record = { received_at: Date.now(), pid: process.pid, payload: data };
    const tmp = path.join(dir, '.' + id + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file); // atomic on same filesystem
  } catch (e) {
    // best-effort only — never break the status line
  }
}

function fmtCost(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  return '$' + n.toFixed(2);
}

// Compact, plain-text (no ANSI) fallback line shown when not wrapping.
function summary(data) {
  if (!data || typeof data !== 'object') return '[cc-usage] (no data)';
  const parts = [];
  const model = data.model && data.model.display_name;
  if (model) parts.push(model);
  const five = data.rate_limits && data.rate_limits.five_hour;
  if (five && typeof five.used_percentage === 'number') {
    parts.push('5h ' + Math.round(five.used_percentage) + '%');
  }
  const cw = data.context_window;
  if (cw && typeof cw.used_percentage === 'number') {
    parts.push('ctx ' + Math.round(cw.used_percentage) + '%');
  }
  const cost = data.cost && fmtCost(data.cost.total_cost_usd);
  if (cost) parts.push(cost);
  return parts.length ? parts.join(' · ') : '[cc-usage]';
}

function runWrapped(cmd, raw) {
  try {
    const res = spawnSync(cmd, {
      shell: true,
      input: raw,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (res && res.status === 0 && typeof res.stdout === 'string' && res.stdout.length) {
      return res.stdout.replace(/\n+$/, '');
    }
  } catch (e) {
    // fall through to our own summary
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = readStdin();

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    data = null;
  }

  persist(data);

  let out = null;
  if (args.wrap) {
    out = runWrapped(args.wrap, raw);
  }
  if (out == null) {
    out = summary(data);
  }
  process.stdout.write(out + '\n');
}

main();
