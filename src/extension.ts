import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { startProxyServer, ProxyServer, UsageEvent } from "./proxyServer";
import {
  Tunnel,
  cloudflaredInstallHint,
  readTunnelState,
  clearTunnelState,
} from "./tunnel";

let outputChannel: vscode.OutputChannel;
const LOG_FILE = path.join(os.tmpdir(), "cursor-proxy.log");
let statusBarItem: vscode.StatusBarItem;
let proxy: ProxyServer | null = null;
let tunnel: Tunnel | null = null;
let currentUrl: string | null = null;
let acknowledgedUrl: string | null = null;
let lastUsage: UsageEvent | null = null;
let enabled = false;
let starting = false;
let ctxRef: vscode.ExtensionContext | null = null;

// Cumulative cost for the active tunnel. Resets only on URL change or stop.
let tunnelCostUrl: string | null = null;
let tunnelCostTotal = 0;
let tunnelRequestCount = 0;

const ACK_KEY = "cursorProxy.acknowledgedUrl";

// process.kill(pid,0) catches a dead process but not a dead edge connection,
// which is the common laptop-sleep failure. Poll the public URL instead.
const HEALTH_INTERVAL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 8_000;
const HEALTH_MAX_FAILURES = 2;
let healthTimer: NodeJS.Timeout | null = null;
let healthFailures = 0;
let healthInFlight = false;

// Respawn backoff for cloudflared death. Resets on a successful URL, caps so
// we don't hammer the system if the binary is uninstalled mid-session.
let cloudflaredMissing = false;
let tunnelRespawnAttempts = 0;
const TUNNEL_RESPAWN_BASE_MS = 2_000;
const TUNNEL_RESPAWN_MAX_MS = 60_000;
const TUNNEL_RESPAWN_MAX_ATTEMPTS = 8;
let tunnelRespawnTimer: NodeJS.Timeout | null = null;

// Local-only mode: cloudflared is intentionally disabled by config. We still
// run the proxy server on 127.0.0.1:<port>; the user is expected to put their
// own tunnel/forwarder in front of it (or use it locally on the same machine).
let localOnlyMode = false;

// Multi-window coordination. Each Cursor window runs its own extension host;
// only one can bind 127.0.0.1:<port>. The first one wins and becomes the
// "owner" (runs proxy server + cloudflared). Subsequent windows detect the
// already-bound port, probe /health to confirm it's our proxy, and attach in
// "adopted" mode: surface the same URL via the shared tunnel state file but
// don't try to bind anything. If the owner dies, the next /health failure
// triggers a takeover attempt.
let adoptedMode = false;
let adoptedTimer: NodeJS.Timeout | null = null;
let adoptedFailures = 0;
const ADOPT_PROBE_TIMEOUT_MS = 2_000;
const ADOPT_POLL_MS = 5_000;
const ADOPT_TAKEOVER_FAILS = 2;

function log(line: string) {
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  // pid prefix matters: multiple Cursor windows append to the same log file,
  // so without it adopted-mode logs interleave with the owner's and you can't
  // tell which window did what.
  const msg = `${ts} pid=${process.pid} ${line}`;
  outputChannel.appendLine(msg);
  try {
    fs.appendFileSync(LOG_FILE, msg + "\n");
  } catch {
    /* ignore */
  }
}

async function setAcknowledged(url: string | null) {
  acknowledgedUrl = url;
  try {
    await ctxRef?.globalState.update(ACK_KEY, url);
  } catch (e) {
    log(`[ack] persist failed: ${(e as Error).message}`);
  }
}

function refreshStatusBar() {
  if (!enabled) {
    statusBarItem.text = "$(plug) Proxy: off";
    statusBarItem.tooltip = "Cursor proxy is off. Click to start.";
    statusBarItem.backgroundColor = undefined;
    return;
  }
  if (starting) {
    statusBarItem.text = "$(sync~spin) Proxy: starting…";
    statusBarItem.tooltip = "Cursor proxy is starting…";
    statusBarItem.backgroundColor = undefined;
    return;
  }
  if (!currentUrl) {
    if (cloudflaredMissing) {
      statusBarItem.text = "$(error) Proxy: cloudflared missing";
      statusBarItem.tooltip =
        `cloudflared binary not found on PATH or known install locations.\n` +
        `Install it (${cloudflaredInstallHint()}), then click → Refresh Tunnel URL.\n` +
        `The local proxy is still listening on 127.0.0.1; you can use it directly if you don't need the public tunnel.`;
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      return;
    }
    statusBarItem.text = "$(alert) Proxy: tunnel down";
    statusBarItem.tooltip =
      "Cloudflared tunnel is not running.\nClick for actions.";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    return;
  }
  if (currentUrl !== acknowledgedUrl) {
    statusBarItem.text = "$(alert) Proxy: new URL";
    statusBarItem.tooltip =
      `Tunnel URL is now ${currentUrl}/v1.\n` +
      `Click → "Copy URL & Open Models Settings".\n` +
      `Paste into "Override OpenAI Base URL".`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    return;
  }
  const totalStr =
    !adoptedMode && tunnelRequestCount > 0
      ? ` · $${formatCost(tunnelCostTotal)}`
      : "";
  const modeStr = adoptedMode
    ? " (shared)"
    : localOnlyMode
      ? " (local)"
      : "";
  statusBarItem.text = `$(globe) Proxy: on${modeStr}${totalStr}`;
  const modeNote = adoptedMode
    ? " (shared with another Cursor window)"
    : localOnlyMode
      ? " (local-only, cloudflared disabled)"
      : "";
  statusBarItem.tooltip =
    `Cursor proxy on${modeNote}.\n` +
    `Base URL: ${currentUrl}/v1\n` +
    (adoptedMode
      ? `This window is attached to the proxy owned by another Cursor window. Usage/cost is tracked there.\n`
      : localOnlyMode
        ? `cloudflared spawn is disabled in settings. Use your own tunnel/forwarder, or unset cursorProxy.disableTunnel.\n`
        : tunnelRequestCount > 0
          ? `Tunnel total: $${tunnelCostTotal.toFixed(4)} across ${tunnelRequestCount} request${tunnelRequestCount === 1 ? "" : "s"}\n`
          : "") +
    (!adoptedMode && lastUsage
      ? `Last turn: ${lastUsage.model} cached=${pct(lastUsage)}% cost=$${lastUsage.cost.toFixed(4)}`
      : !adoptedMode
        ? `No traffic yet.`
        : ``) +
    `\nClick for actions.`;
  statusBarItem.backgroundColor = undefined;
}

function formatCost(c: number): string {
  return c >= 1 ? c.toFixed(2) : c.toFixed(4);
}

function pct(u: UsageEvent): string {
  const total = u.input + u.cacheCreate + u.cacheRead;
  if (total <= 0) return "0";
  return ((100 * u.cacheRead) / total).toFixed(0);
}

function applyUrl(url: string) {
  log(`[tunnel] URL: ${url}`);
  currentUrl = url;
  if (tunnelCostUrl !== url) {
    if (tunnelCostUrl !== null) {
      log(
        `[tunnel] URL changed (${tunnelCostUrl} → ${url}); resetting tunnel cost total`
      );
    }
    tunnelCostUrl = url;
    tunnelCostTotal = 0;
    tunnelRequestCount = 0;
  }
  // A working URL clears all error states.
  healthFailures = 0;
  cloudflaredMissing = false;
  tunnelRespawnAttempts = 0;
  if (tunnelRespawnTimer) {
    clearTimeout(tunnelRespawnTimer);
    tunnelRespawnTimer = null;
  }
  refreshStatusBar();
  startHealthCheck();
}

function scheduleTunnelRespawn() {
  if (!enabled || !tunnel) return;
  if (tunnelRespawnTimer) return;

  tunnelRespawnAttempts += 1;
  if (tunnelRespawnAttempts > TUNNEL_RESPAWN_MAX_ATTEMPTS) {
    cloudflaredMissing = true;
    log(
      `[tunnel] giving up after ${TUNNEL_RESPAWN_MAX_ATTEMPTS} respawn attempts; ` +
        `surfacing 'cloudflared missing' state. Click Refresh Tunnel URL to retry.`
    );
    refreshStatusBar();
    return;
  }

  const delay = Math.min(
    TUNNEL_RESPAWN_BASE_MS * 2 ** (tunnelRespawnAttempts - 1),
    TUNNEL_RESPAWN_MAX_MS
  );
  log(
    `[tunnel] respawn attempt ${tunnelRespawnAttempts}/${TUNNEL_RESPAWN_MAX_ATTEMPTS} in ${delay}ms`
  );
  tunnelRespawnTimer = setTimeout(() => {
    tunnelRespawnTimer = null;
    if (!enabled || !tunnel) return;
    const ok = tunnel.start();
    if (!ok) {
      // Couldn't even spawn — binary is gone. Mark missing and stop retrying.
      cloudflaredMissing = true;
      log("[tunnel] respawn failed: cloudflared binary not found");
      refreshStatusBar();
    }
  }, delay);
}

function handleTunnelExit() {
  if (!enabled || !tunnel) return;
  log("[tunnel] cloudflared died");
  currentUrl = null;
  stopHealthCheck();
  refreshStatusBar();
  scheduleTunnelRespawn();
}

function startHealthCheck() {
  stopHealthCheck();
  setTimeout(() => void runHealthProbe("startup"), 2_000);
  healthTimer = setInterval(
    () => void runHealthProbe("interval"),
    HEALTH_INTERVAL_MS
  );
}

function stopHealthCheck() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  healthFailures = 0;
}

async function runHealthProbe(reason: string): Promise<void> {
  if (!enabled || !currentUrl) return;
  if (healthInFlight) return;
  const probedUrl = currentUrl;
  const target = `${probedUrl}/health`;
  healthInFlight = true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  let ok = false;
  let detail = "";
  try {
    const res = await fetch(target, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "User-Agent": "cursor-proxy-healthcheck/1" },
    });
    ok = res.ok;
    detail = `HTTP ${res.status}`;
  } catch (e) {
    detail = (e as Error).name === "AbortError" ? "timeout" : (e as Error).message;
  } finally {
    clearTimeout(timer);
    healthInFlight = false;
  }

  // Ignore probe results for a URL we no longer hold.
  if (probedUrl !== currentUrl) return;

  if (ok) {
    if (healthFailures > 0) {
      log(`[health] ${target} recovered after ${healthFailures} failures`);
    }
    healthFailures = 0;
    return;
  }

  healthFailures += 1;
  log(
    `[health] ${target} unhealthy (${detail}) ${healthFailures}/${HEALTH_MAX_FAILURES} reason=${reason}`
  );
  if (healthFailures < HEALTH_MAX_FAILURES) return;

  log("[health] tunnel unreachable — forcing refresh");
  healthFailures = 0;
  currentUrl = null;
  refreshStatusBar();
  refresh().catch((e) =>
    log(`[health] refresh threw: ${(e as Error).message}`)
  );
}

async function probeLocalHealth(
  port: number,
  timeoutMs: number
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "cursor-proxy-adoption-probe/1" },
    });
    if (!res.ok) return false;
    const txt = await res.text();
    // Match our /health response specifically — refuse to adopt some random
    // other server happening to listen on the same port.
    return txt.includes('"status":"ok"');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function pullAdoptedUrl() {
  const cfg = vscode.workspace.getConfiguration("cursorProxy");
  const port = cfg.get<number>("port", 9000);
  // Prefer the public cloudflared URL if the owner has one; otherwise the
  // owner is in local-only mode (or hasn't gotten a tunnel URL yet) and the
  // local URL is the right thing to surface — we already proved /health is
  // reachable on it during adoption.
  const s = readTunnelState();
  const next =
    s && s.url && s.port === port ? s.url : `http://127.0.0.1:${port}`;
  if (next === currentUrl) return;
  log(`[adopt] picked up URL from owner: ${next}`);
  currentUrl = next;
  if (tunnelCostUrl !== next) {
    tunnelCostUrl = next;
    tunnelCostTotal = 0;
    tunnelRequestCount = 0;
  }
  refreshStatusBar();
}

function startAdoptedSupervisor(port: number) {
  stopAdoptedSupervisor();
  adoptedFailures = 0;
  pullAdoptedUrl();
  adoptedTimer = setInterval(() => {
    if (!adoptedMode) {
      stopAdoptedSupervisor();
      return;
    }
    void (async () => {
      const ok = await probeLocalHealth(port, ADOPT_PROBE_TIMEOUT_MS);
      if (ok) {
        adoptedFailures = 0;
        pullAdoptedUrl();
        return;
      }
      adoptedFailures += 1;
      log(
        `[adopt] owner /health failed ${adoptedFailures}/${ADOPT_TAKEOVER_FAILS}`
      );
      if (adoptedFailures < ADOPT_TAKEOVER_FAILS) return;

      log("[adopt] owner appears dead — releasing and attempting takeover");
      stopAdoptedSupervisor();
      adoptedMode = false;
      adoptedFailures = 0;
      enabled = false;
      starting = false;
      currentUrl = null;
      refreshStatusBar();
      try {
        await startAll();
      } catch (e) {
        log(`[adopt] takeover startAll threw: ${(e as Error).message}`);
      }
    })();
  }, ADOPT_POLL_MS);
}

function stopAdoptedSupervisor() {
  if (adoptedTimer) {
    clearInterval(adoptedTimer);
    adoptedTimer = null;
  }
  adoptedFailures = 0;
}

async function startAll(): Promise<void> {
  if (enabled || starting) {
    log(`[startAll] skipped: enabled=${enabled} starting=${starting}`);
    return;
  }
  starting = true;
  refreshStatusBar();
  const cfg = vscode.workspace.getConfiguration("cursorProxy");
  const port = cfg.get<number>("port", 9000);
  log(`[startAll] port=${port}`);

  try {
    proxy = await startProxyServer({
      port,
      log,
      backgroundFallbackModel: cfg.get<string>(
        "backgroundFallbackModel",
        "anthropic/claude-3.5-haiku"
      ),
      minMaxTokens: cfg.get<number>("minMaxTokens", 16384),
      use1hCache: cfg.get<boolean>("use1hCache", true),
      pinAnthropic: cfg.get<boolean>("pinAnthropic", true),
      referer: cfg.get<string>("attributionReferer", ""),
      appTitle: cfg.get<string>("attributionTitle", ""),
    });
    log(`[startAll] proxy server listening on 127.0.0.1:${port}`);
    proxy.onUsage((u) => {
      lastUsage = u;
      if (currentUrl && tunnelCostUrl === currentUrl) {
        tunnelCostTotal += u.cost;
        tunnelRequestCount += 1;
      }
      refreshStatusBar();
    });
  } catch (e) {
    const msg = (e as Error).message;
    // EADDRINUSE almost always means another Cursor window already owns the
    // proxy on this machine. Probe /health: if it answers like ours, attach
    // in adopted mode so this window shares the URL instead of erroring out.
    if (/EADDRINUSE/i.test(msg)) {
      log(`[startAll] port ${port} busy; probing for an existing cursor proxy`);
      const adopted = await probeLocalHealth(port, ADOPT_PROBE_TIMEOUT_MS);
      if (adopted) {
        log(`[startAll] adopted existing proxy on 127.0.0.1:${port}`);
        adoptedMode = true;
        enabled = true;
        starting = false;
        cloudflaredMissing = false;
        startAdoptedSupervisor(port);
        refreshStatusBar();
        return;
      }
      log(
        `[startAll] port ${port} busy but /health didn't answer like ours — refusing to adopt`
      );
    }
    log(`[proxy] failed to start: ${msg}`);
    vscode.window.showErrorMessage(
      `Cursor proxy: could not bind 127.0.0.1:${port}. ${msg}`
    );
    starting = false;
    refreshStatusBar();
    return;
  }

  // Honour `disableTunnel`: skip cloudflared entirely. Surface the local URL
  // as the canonical one so "Copy URL" still works for users with their own
  // tunnel solution.
  if (cfg.get<boolean>("disableTunnel", false)) {
    localOnlyMode = true;
    enabled = true;
    starting = false;
    currentUrl = `http://127.0.0.1:${port}`;
    tunnelCostUrl = currentUrl;
    tunnelCostTotal = 0;
    tunnelRequestCount = 0;
    // Wipe any leftover cloudflared state from a previous session so adopted
    // windows don't surface a stale public URL that no longer routes here.
    clearTunnelState();
    log(`[startAll] disableTunnel=true → local-only mode at ${currentUrl}`);
    refreshStatusBar();
    return;
  }
  localOnlyMode = false;

  tunnel = new Tunnel({
    port,
    log,
    onUrl: (url) => applyUrl(url),
    onExit: handleTunnelExit,
    cloudflaredPath: cfg.get<string>("cloudflaredPath", ""),
  });

  enabled = true;
  starting = false;

  if (!tunnel.start()) {
    // Local proxy is fine; only the public tunnel is missing. Surface it
    // clearly without killing the in-process server — users with a different
    // tunnel solution (e.g. ngrok, Tailscale Funnel) can still hit
    // 127.0.0.1:<port> directly.
    cloudflaredMissing = true;
    const customPath = cfg.get<string>("cloudflaredPath", "").trim();
    if (customPath) {
      log(`[startAll] configured cloudflaredPath invalid: ${customPath}`);
      vscode.window.showWarningMessage(
        `Cursor proxy: configured cloudflaredPath does not exist or is not executable: ${customPath}. ` +
          `The local proxy is still running on 127.0.0.1:${port}.`
      );
    } else {
      log(`[startAll] cloudflared not found. Install: ${cloudflaredInstallHint()}`);
      vscode.window.showWarningMessage(
        `Cursor proxy is running locally on 127.0.0.1:${port}, but cloudflared was not found. ` +
          `Install it to get a public URL: ${cloudflaredInstallHint()}`
      );
    }
    refreshStatusBar();
    return;
  }
  log("[startAll] cloudflared spawned; waiting for URL…");
  refreshStatusBar();
}

async function stopAll(): Promise<void> {
  if (!enabled && !starting) return;
  log("[proxy] disabling…");
  // Adopted windows don't own the server or the tunnel; "stop" here just
  // detaches this window's view. Other windows keep using the shared proxy.
  if (adoptedMode) {
    stopAdoptedSupervisor();
    adoptedMode = false;
    enabled = false;
    starting = false;
    currentUrl = null;
    tunnelCostUrl = null;
    tunnelCostTotal = 0;
    tunnelRequestCount = 0;
    refreshStatusBar();
    log("[proxy] detached from shared proxy (other windows still own it)");
    return;
  }
  stopHealthCheck();
  if (tunnelRespawnTimer) {
    clearTimeout(tunnelRespawnTimer);
    tunnelRespawnTimer = null;
  }
  tunnel?.stop();
  tunnel = null;
  await proxy?.close();
  proxy = null;
  enabled = false;
  starting = false;
  currentUrl = null;
  tunnelCostUrl = null;
  tunnelCostTotal = 0;
  tunnelRequestCount = 0;
  cloudflaredMissing = false;
  localOnlyMode = false;
  tunnelRespawnAttempts = 0;
  refreshStatusBar();
}

// Release handles without killing cloudflared, so the next activation can
// adopt the same tunnel and the URL doesn't rotate on every reload.
async function detachAll(): Promise<void> {
  if (adoptedMode) {
    log("[deactivate] adopted mode — only releasing supervisor");
    stopAdoptedSupervisor();
    adoptedMode = false;
    return;
  }
  log("[deactivate] detaching tunnel (cloudflared keeps running)");
  stopHealthCheck();
  tunnel?.detach();
  tunnel = null;
  await proxy?.close();
  proxy = null;
}

// Copy the current URL to clipboard, jump to Cursor's Models settings page,
// and mark the URL as acknowledged so the status bar stops nagging.
async function applyCurrentUrl() {
  if (!currentUrl) return;
  const baseUrl = `${currentUrl}/v1`;
  await vscode.env.clipboard.writeText(baseUrl);
  await setAcknowledged(currentUrl);
  try {
    await vscode.commands.executeCommand("aiSettings.action.open", "models");
  } catch (e) {
    log(`[apply] aiSettings.action.open failed: ${(e as Error).message}`);
    // aiSettings.action.open is Cursor-only; degrade to stock VS Code's
    // settings command.
    try {
      await vscode.commands.executeCommand("workbench.action.openSettings");
    } catch {
      /* ignore */
    }
  }
  vscode.window.showInformationMessage(
    `Copied ${baseUrl} to clipboard. Paste it into "Override OpenAI Base URL" on the Models page.`
  );
  refreshStatusBar();
}

async function toggle() {
  try {
    if (enabled || starting) {
      log("[toggle] on → stopAll");
      await stopAll();
    } else {
      log("[toggle] off → startAll");
      await startAll();
    }
  } catch (e) {
    log(`[toggle] threw: ${(e as Error).stack ?? (e as Error).message}`);
    vscode.window.showErrorMessage(
      `Cursor proxy toggle failed: ${(e as Error).message}`
    );
  }
}

async function showMenu() {
  if (!enabled && !starting) {
    log("[menu] off → startAll");
    await startAll();
    return;
  }
  type MenuItem = vscode.QuickPickItem & { id: string };
  const items: MenuItem[] = [];

  if (currentUrl) {
    const isNew = currentUrl !== acknowledgedUrl;
    items.push({
      id: "copyUrl",
      label: `$(clippy) Copy URL & Open Models Settings${isNew ? " (new URL)" : ""}`,
      description: `${currentUrl}/v1`,
    });
  } else if (!adoptedMode) {
    items.push({
      id: "refresh",
      label: "$(refresh) Restart Tunnel",
      description: "Cloudflared is not running",
    });
  }
  if (currentUrl && !adoptedMode && !localOnlyMode) {
    items.push({
      id: "refresh",
      label: "$(refresh) Refresh Tunnel URL",
      description: "Kill cloudflared and get a new URL",
    });
  }
  items.push({
    id: "configure",
    label: "$(gear) Open Settings",
    description: "Port, model fallback, tunnel options, attribution",
  });
  items.push({
    id: "showLogs",
    label: "$(output) Show Logs",
  });
  items.push({
    id: "stop",
    label: adoptedMode
      ? "$(debug-disconnect) Detach (other windows keep proxy running)"
      : "$(circle-slash) Stop Proxy",
  });

  const placeHolder = starting
    ? "Cursor Proxy: starting…"
    : currentUrl
      ? `Cursor Proxy: ${currentUrl}/v1`
      : "Cursor Proxy: tunnel down";

  const picked = await vscode.window.showQuickPick(items, { placeHolder });
  if (!picked) return;
  switch (picked.id) {
    case "copyUrl":
      await applyCurrentUrl();
      break;
    case "refresh":
      await refresh();
      break;
    case "configure":
      await openSettings();
      break;
    case "showLogs":
      outputChannel.show();
      break;
    case "stop":
      await stopAll();
      break;
  }
}

async function openSettings() {
  // VS Code's openSettings command accepts a search query that scopes the UI
  // to a specific extension's contributed settings via `@ext:<publisher>.<id>`.
  try {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@ext:ohadbaehr.cursor-openrouter-proxy"
    );
  } catch (e) {
    log(`[settings] open via @ext failed: ${(e as Error).message}`);
    try {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "cursorProxy"
      );
    } catch {
      /* last-ditch best-effort */
    }
  }
}

async function refresh() {
  if (adoptedMode) {
    log("[refresh] ignored: this window is adopted; owner controls the tunnel");
    vscode.window.showInformationMessage(
      "Cursor proxy: this window is sharing the tunnel from another Cursor window. " +
        "Refresh from the window that owns the proxy."
    );
    return;
  }
  if (!enabled || !tunnel) {
    await startAll();
    return;
  }
  log("[tunnel] manual refresh — killing cloudflared");
  stopHealthCheck();
  tunnel.stop();
  currentUrl = null;
  // Manual refresh = user intent; clear any "give up" state and reset
  // backoff so we'll actually retry promptly.
  cloudflaredMissing = false;
  tunnelRespawnAttempts = 0;
  if (tunnelRespawnTimer) {
    clearTimeout(tunnelRespawnTimer);
    tunnelRespawnTimer = null;
  }
  refreshStatusBar();
  // let SIGTERM land before respawn
  await new Promise((r) => setTimeout(r, 500));
  tunnel = new Tunnel({
    port: proxy!.port,
    log,
    onUrl: (url) => applyUrl(url),
    onExit: handleTunnelExit,
  });
  if (!tunnel.start()) {
    cloudflaredMissing = true;
    log(`[refresh] cloudflared not found. Install: ${cloudflaredInstallHint()}`);
    vscode.window.showWarningMessage(
      `cloudflared not found. Install: ${cloudflaredInstallHint()}`
    );
    refreshStatusBar();
  }
}

// Sweep state left behind by a pre-release pinner daemon, in case anyone
// upgrades from a development build.
function killLegacyPinner() {
  const stateDir = path.join(os.tmpdir(), "cursor-proxy");
  const pidFile = path.join(stateDir, "pinner.pid");
  const targetFile = path.join(stateDir, "pin-target.json");
  const scriptFile = path.join(stateDir, "pinner.js");
  const logFile = path.join(stateDir, "pinner.log");

  try {
    if (fs.existsSync(targetFile)) {
      fs.writeFileSync(
        targetFile,
        JSON.stringify({ stop: true, updatedAt: Date.now() })
      );
    }
  } catch {
    /* ignore */
  }
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        log(`[upgrade] killing legacy pinner pid=${pid}`);
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      } catch {
        /* not alive */
      }
    }
  } catch {
    /* no pid file */
  }
  for (const f of [pidFile, targetFile, scriptFile, logFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* missing is fine */
    }
  }
}

export async function activate(ctx: vscode.ExtensionContext) {
  ctxRef = ctx;
  try {
    fs.writeFileSync(
      LOG_FILE,
      `=== activate ${new Date().toISOString()} pid=${process.pid} ===\n`
    );
  } catch (e) {
    try {
      fs.appendFileSync(
        path.join(os.homedir(), ".cursor-proxy.boot.log"),
        `boot ${new Date().toISOString()} writeFile-err: ${(e as Error).message}\n`
      );
    } catch {
      /* truly nothing we can do */
    }
  }
  outputChannel = vscode.window.createOutputChannel("Cursor Proxy");
  ctx.subscriptions.push(outputChannel);
  log(`[boot] extension activated, log file: ${LOG_FILE}`);

  acknowledgedUrl = ctx.globalState.get<string>(ACK_KEY, "") || null;
  log(`[boot] acknowledgedUrl=${acknowledgedUrl ?? "<none>"}`);

  killLegacyPinner();

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "cursorProxy.menu";
  statusBarItem.show();
  ctx.subscriptions.push(statusBarItem);

  ctx.subscriptions.push(
    vscode.commands.registerCommand("cursorProxy.menu", showMenu),
    vscode.commands.registerCommand("cursorProxy.toggle", toggle),
    vscode.commands.registerCommand("cursorProxy.refresh", refresh),
    vscode.commands.registerCommand("cursorProxy.copyUrl", async () => {
      if (!currentUrl) {
        vscode.window.showWarningMessage(
          "Cursor proxy: no tunnel URL yet. Wait for the tunnel to come up."
        );
        return;
      }
      await applyCurrentUrl();
    }),
    vscode.commands.registerCommand("cursorProxy.showLogs", () => {
      outputChannel.show();
    }),
    vscode.commands.registerCommand("cursorProxy.configure", openSettings)
  );

  // Live config reload. Settings that affect the running server (port,
  // disableTunnel, cloudflaredPath) require a restart of the proxy to take
  // effect. Offer it instead of silently ignoring the change.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration("cursorProxy")) return;
      const restartKeys = [
        "cursorProxy.port",
        "cursorProxy.disableTunnel",
        "cursorProxy.cloudflaredPath",
      ];
      const needsRestart = restartKeys.some((k) => e.affectsConfiguration(k));
      if (!needsRestart) return;
      if (!enabled && !starting) return;
      log("[config] proxy-affecting setting changed; offering restart");
      const choice = await vscode.window.showInformationMessage(
        "Cursor Proxy: a setting that affects the running proxy was changed. Restart now?",
        "Restart",
        "Later"
      );
      if (choice !== "Restart") return;
      await stopAll();
      await startAll();
    })
  );

  // setInterval doesn't fire reliably during sleep; window focus does.
  ctx.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      if (!enabled || !currentUrl) return;
      void runHealthProbe("focus");
    })
  );

  refreshStatusBar();

  const cfg = vscode.workspace.getConfiguration("cursorProxy");
  if (cfg.get<boolean>("autoStart", true)) {
    log("[boot] autoStart=true → starting proxy");
    try {
      await startAll();
    } catch (e) {
      log(
        `[boot] startAll threw: ${(e as Error).stack ?? (e as Error).message}`
      );
    }
  } else {
    log("[boot] autoStart=false; user must click status bar to start");
  }
}

export async function deactivate() {
  await detachAll();
}
