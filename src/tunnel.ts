import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Quick tunnels rotate URLs on restart, so we keep cloudflared alive across
// extension-host reloads (`detached` + `unref`) and persist {pid,url,port}
// to disk; the next activation adopts the running process.

const CLOUDFLARED_CANDIDATES = [
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
  `${process.env.HOME ?? ""}/.local/bin/cloudflared`,
];

const STATE_DIR = path.join(os.tmpdir(), "cursor-proxy");
const STATE_FILE = path.join(STATE_DIR, "tunnel.json");
const TUNNEL_LOG = path.join(STATE_DIR, "cloudflared.log");

interface State {
  pid: number;
  url: string;
  port: number;
  startedAt: number;
}

function findCloudflared(): string | null {
  for (const p of CLOUDFLARED_CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
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

    const bin = findCloudflared();
    if (!bin) {
      this.opts.log(
        "[tunnel] cloudflared not found. Install: brew install cloudflared"
      );
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
