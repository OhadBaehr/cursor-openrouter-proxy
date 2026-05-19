import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Quick tunnels rotate URLs on restart, so we keep cloudflared alive across
// extension-host reloads (`detached` + `unref`) and persist {pid,url,port}
// to disk; the next activation adopts the running process.

const IS_WINDOWS = process.platform === "win32";
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";

// Common install locations on macOS / Linux / Windows. Order matters: PATH
// lookup is the most reliable (handled separately below), and these candidates
// are only the well-known fallbacks for installs that don't update PATH.
function cloudflaredCandidates(): string[] {
  if (IS_WINDOWS) {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return [
      path.join(programFiles, "cloudflared", "cloudflared.exe"),
      path.join(programFilesX86, "cloudflared", "cloudflared.exe"),
      path.join(
        localAppData,
        "Microsoft",
        "WinGet",
        "Links",
        "cloudflared.exe"
      ),
      path.join(HOME, ".cloudflared", "cloudflared.exe"),
      path.join(HOME, "scoop", "shims", "cloudflared.exe"),
    ];
  }
  return [
    "/opt/homebrew/bin/cloudflared", // macOS Homebrew (Apple Silicon)
    "/usr/local/bin/cloudflared", // macOS Homebrew (Intel) / Linux manual
    "/usr/bin/cloudflared", // Linux package managers
    path.join(HOME, ".local/bin/cloudflared"),
  ];
}

const STATE_DIR = path.join(os.tmpdir(), "cursor-proxy");
const STATE_FILE = path.join(STATE_DIR, "tunnel.json");
const TUNNEL_LOG = path.join(STATE_DIR, "cloudflared.log");

// Suggest the install command for the current OS in the error message we
// surface when cloudflared isn't on the system.
export function cloudflaredInstallHint(): string {
  if (IS_WINDOWS) return "winget install --id Cloudflare.cloudflared";
  if (process.platform === "darwin") return "brew install cloudflared";
  return "see https://github.com/cloudflare/cloudflared/releases or your distro's package manager";
}

interface State {
  pid: number;
  url: string;
  port: number;
  startedAt: number;
}

function findCloudflared(override?: string): string | null {
  // 0. Explicit user-configured override wins. Fail loudly (return null) if
  // it doesn't exist instead of silently falling back — the user explicitly
  // pointed us at a path and we should respect that intent.
  if (override && override.trim()) {
    const p = override.trim();
    try {
      if (IS_WINDOWS) {
        if (fs.existsSync(p)) return p;
      } else {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      }
    } catch {
      /* fall through to null below */
    }
    return null;
  }

  // 1. PATH lookup via the OS's own command-finder. This catches whatever the
  // user actually installed (Homebrew, winget, scoop, apt, manual unzip, …)
  // without us hard-coding paths.
  try {
    const finder = IS_WINDOWS ? "where" : "which";
    const arg = IS_WINDOWS ? "cloudflared.exe" : "cloudflared";
    const out = execFileSync(finder, [arg], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s);
    if (first && fs.existsSync(first)) return first;
  } catch {
    /* not on PATH; fall through to well-known locations */
  }

  // 2. Well-known install locations for the current OS. X_OK doesn't apply
  // on Windows (NTFS has no exec bit), so just check existence there.
  for (const p of cloudflaredCandidates()) {
    try {
      if (IS_WINDOWS) {
        if (fs.existsSync(p)) return p;
      } else {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function processAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Public read-only view of the tunnel state file. Used by adopted (non-owner)
// extension hosts to surface the current URL without spawning their own
// cloudflared.
export function readTunnelState(): State | null {
  return readState();
}

// Public hook so the owner can wipe stale tunnel state (e.g. when starting in
// local-only mode after a previous session left a cloudflared URL behind).
export function clearTunnelState(): void {
  clearState();
}

function readState(): State | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    if (
      typeof s?.pid === "number" &&
      typeof s?.url === "string" &&
      typeof s?.port === "number"
    ) {
      return s as State;
    }
  } catch {
    /* missing or malformed */
  }
  return null;
}

function writeState(s: State): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {
    /* best-effort */
  }
}

function clearState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    /* ignore */
  }
}

export interface TunnelOptions {
  port: number;
  log: (line: string) => void;
  onUrl: (url: string) => void;
  onExit: () => void;
  // Optional explicit cloudflared binary path. If set, discovery is skipped.
  cloudflaredPath?: string;
}

export class Tunnel {
  private currentUrl: string | null = null;
  private pid: number | null = null;
  private stopped = false;
  private urlWatcher: NodeJS.Timeout | null = null;
  private aliveWatcher: NodeJS.Timeout | null = null;

  constructor(private opts: TunnelOptions) {}

  start(): boolean {
    this.stopped = false;

    const existing = readState();
    if (
      existing &&
      existing.port === this.opts.port &&
      processAlive(existing.pid)
    ) {
      this.opts.log(
        `[tunnel] adopting existing cloudflared pid=${existing.pid} url=${existing.url}`
      );
      this.pid = existing.pid;
      this.currentUrl = existing.url;
      setImmediate(() => this.opts.onUrl(existing.url));
      this.startAliveWatcher();
      return true;
    }
    if (existing) {
      this.opts.log(
        `[tunnel] discarding stale state (pid=${existing.pid} alive=${processAlive(
          existing.pid
        )} port=${existing.port} want=${this.opts.port})`
      );
      clearState();
    }

    const bin = findCloudflared(this.opts.cloudflaredPath);
    if (!bin) {
      if (this.opts.cloudflaredPath && this.opts.cloudflaredPath.trim()) {
        this.opts.log(
          `[tunnel] configured cloudflaredPath does not exist or is not executable: ${this.opts.cloudflaredPath}`
        );
      } else {
        this.opts.log(
          `[tunnel] cloudflared not found. Install: ${cloudflaredInstallHint()}`
        );
      }
      return false;
    }

    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      // Truncate so we only match URLs from this run.
      fs.writeFileSync(TUNNEL_LOG, "");
    } catch (e) {
      this.opts.log(
        `[tunnel] cannot prep log dir ${STATE_DIR}: ${(e as Error).message}`
      );
      return false;
    }

    let outFd: number;
    let errFd: number;
    try {
      outFd = fs.openSync(TUNNEL_LOG, "a");
      errFd = fs.openSync(TUNNEL_LOG, "a");
    } catch (e) {
      this.opts.log(
        `[tunnel] cannot open ${TUNNEL_LOG}: ${(e as Error).message}`
      );
      return false;
    }

    const p = spawn(
      bin,
      [
        "tunnel",
        "--no-autoupdate",
        "--url",
        `http://127.0.0.1:${this.opts.port}`,
      ],
      { stdio: ["ignore", outFd, errFd], detached: true }
    );
    try { fs.closeSync(outFd); } catch { /* ignore */ }
    try { fs.closeSync(errFd); } catch { /* ignore */ }

    if (!p.pid) {
      this.opts.log("[tunnel] failed to spawn cloudflared (no pid)");
      return false;
    }
    p.unref();
    this.pid = p.pid;
    this.opts.log(`[tunnel] spawned cloudflared pid=${this.pid} (detached)`);

    this.startUrlWatcher();
    this.startAliveWatcher();
    return true;
  }

  private startUrlWatcher(): void {
    const startTs = Date.now();
    this.clearUrlWatcher();
    this.urlWatcher = setInterval(() => {
      if (this.stopped || this.currentUrl) {
        this.clearUrlWatcher();
        return;
      }
      if (Date.now() - startTs > 30_000) {
        this.opts.log("[tunnel] timeout waiting for URL (30s)");
        this.clearUrlWatcher();
        return;
      }
      try {
        const content = fs.readFileSync(TUNNEL_LOG, "utf8");
        const m = content.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && this.pid) {
          this.currentUrl = m[0];
          writeState({
            pid: this.pid,
            url: this.currentUrl,
            port: this.opts.port,
            startedAt: Date.now(),
          });
          this.opts.log(`[tunnel] URL: ${this.currentUrl}`);
          this.opts.onUrl(this.currentUrl);
          this.clearUrlWatcher();
        }
      } catch {
        /* log not ready yet */
      }
    }, 250);
  }

  private clearUrlWatcher(): void {
    if (this.urlWatcher) {
      clearInterval(this.urlWatcher);
      this.urlWatcher = null;
    }
  }

  private startAliveWatcher(): void {
    this.clearAliveWatcher();
    this.aliveWatcher = setInterval(() => {
      if (this.stopped || !this.pid) {
        this.clearAliveWatcher();
        return;
      }
      if (!processAlive(this.pid)) {
        this.opts.log(`[tunnel] cloudflared pid=${this.pid} died`);
        this.pid = null;
        this.currentUrl = null;
        clearState();
        this.clearAliveWatcher();
        this.opts.onExit();
      }
    }, 5_000);
  }

  private clearAliveWatcher(): void {
    if (this.aliveWatcher) {
      clearInterval(this.aliveWatcher);
      this.aliveWatcher = null;
    }
  }

  // Release without killing cloudflared, so the tunnel survives reloads.
  detach(): void {
    this.clearUrlWatcher();
    this.clearAliveWatcher();
    this.stopped = true;
    this.pid = null;
    this.currentUrl = null;
  }

  // Kill cloudflared and clear state.
  stop(): void {
    this.clearUrlWatcher();
    this.clearAliveWatcher();
    this.stopped = true;
    const pid = this.pid;
    this.pid = null;
    this.currentUrl = null;
    if (pid && processAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
    clearState();
  }

  get url(): string | null {
    return this.currentUrl;
  }

  get running(): boolean {
    return this.pid != null && processAlive(this.pid);
  }
}
