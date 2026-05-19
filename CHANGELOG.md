# Changelog

All notable changes to this extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-05-19

### Fixed
- **Cost total is now genuinely shared across all Cursor windows.** Cursor's "Override OpenAI Base URL" is a global setting, so there's exactly one active tunnel URL at any given time — the combined `$` figure now reflects every request that hit it, regardless of which window initiated the chat. Previously the owner window tracked cost in process memory and adopted/shared windows showed `Proxy: on (shared)` with no number.
- Owner persists running totals to `%TEMP%\cursor-proxy\cost.json` (atomic rename-write); every other window polls that file every 1.5s and renders the same total/tooltip.

### Changed
- Status bar shows the cost on every window for the active tunnel URL. Dropped the `(shared)` / `(local)` text from the status bar label — they leaked an implementation detail that didn't matter to the user. The tooltip still distinguishes owner vs. shared vs. local-only mode for debugging.
- When the URL changes (cloudflared restart) or the owner runs Stop Proxy, the shared cost file is cleared so the next URL starts at `$0`.

## [0.1.3] - 2026-05-19

### Added
- **`cursorProxy.disableTunnel`** (boolean, default `false`) — skip cloudflared entirely. The proxy still serves on `127.0.0.1:<port>` for use with your own tunnel/forwarder (ngrok, Tailscale Funnel, port-forward, etc.). Status bar shows `Proxy: on (local)` in this mode.
- **`cursorProxy.cloudflaredPath`** (string, default empty) — explicit absolute path to the cloudflared binary. When set, discovery via `PATH` and well-known install locations is skipped; an invalid path now surfaces a clear warning instead of silently falling back.
- **`Cursor Proxy: Open Settings`** command + status-bar menu entry — opens Settings filtered to this extension, so port and other knobs are one click away instead of buried in the global Settings UI.
- **Live config reload.** Changing `port`, `disableTunnel`, or `cloudflaredPath` while the proxy is running now prompts to restart the proxy instead of being silently ignored until the window reloads.

### Fixed
- Adopted (shared) windows correctly fall back to the local URL when the owner is in `disableTunnel` mode, instead of showing stale `trycloudflare.com` URLs left over from a previous session.
- Owner now wipes stale cloudflared state (`tunnel.json`) when starting in local-only mode.

## [0.1.2] - 2026-05-19

### Fixed
- **Multi-window crash on Windows / EADDRINUSE.** Opening a second Cursor window used to fail with `listen EADDRINUSE: address already in use 127.0.0.1:9000` because each extension host tried to bind its own proxy server. The first window now becomes the **owner** (runs the proxy + cloudflared); subsequent windows detect the bound port, probe `/health`, and attach in **adopted** mode — they share the same public URL via the existing tunnel state file and surface a `Proxy: on (shared)` status. If the owner window closes, an adopted window automatically takes over the next time `/health` fails (capped at 2 consecutive failures, ~10s).
- Adopted windows hide owner-only menu actions (refresh / restart) and rebrand "Stop Proxy" as "Detach", so stopping in a viewer window doesn't accidentally kill the tunnel for the owner.

### Changed
- Log lines now include `pid=` so interleaved entries from multiple Cursor windows in the shared `cursor-proxy.log` file are attributable to a specific extension host.

## [0.1.1] - 2026-05-19

### Added
- **Windows / Linux support.** Cloudflared is now discovered via `where` / `which` against `PATH` first, then via OS-specific well-known install locations: `Program Files\cloudflared`, `LOCALAPPDATA\Microsoft\WinGet\Links`, `~\.cloudflared`, `~\scoop\shims` on Windows; `/usr/bin`, `/usr/local/bin`, `~/.local/bin` on Linux (in addition to existing Homebrew paths on macOS).
- **Distinct red status-bar state** when cloudflared is missing entirely. The local proxy keeps running on `127.0.0.1:<port>` so users with their own tunnel (ngrok, Tailscale Funnel, port forward, …) can still use the extension.
- **Capped exponential respawn backoff** when cloudflared dies repeatedly (2s → 4s → … → 60s, max 8 attempts). Replaces the previous unconditional 2s respawn loop.

### Changed
- "cloudflared not found" toast and status-bar tooltip now print the correct install command for the current OS (`brew install cloudflared` / `winget install --id Cloudflare.cloudflared` / cloudflared releases page).
- README quickstart split per-OS; no more macOS-only assumptions.
- Cold-start with missing cloudflared no longer tears down the in-process proxy.

## [0.1.0] - 2026-05-19

First public release.

### Proxy & protocol translation
- In-process OpenAI-compatible proxy that translates Cursor's Anthropic-shape requests to OpenRouter's `/v1/messages` so `cache_control` markers survive.
- Pins routing to Anthropic-direct so prompt caches don't fragment across providers.
- Upgrades `cache_control: ephemeral` to Anthropic's 1-hour TTL beta so idle gaps don't kill the cache.
- Raises `max_tokens` to 16k by default so long tool-call payloads don't truncate ("Edit attempted" toasts).
- Demotes Cursor's background variants (`thinking`, `xhigh`, `xmedium`, `xlow`, `-auto`) to a cheap configurable fallback model so they don't 400 on OpenRouter.

### Public tunnel
- Spawns `cloudflared` for a free public quick-tunnel and surfaces the URL in the status bar with one-click copy + deep-link to **Cursor Settings → Models**.
- Survives Cursor extension-host reloads by detaching the cloudflared process and persisting `{pid,url,port}` to disk; the next activation adopts the running tunnel instead of rotating the URL.
- HTTP health-checks the public tunnel every 30s and on every window focus; auto-refreshes after two consecutive failures so the laptop-sleep "stale URL with no warning" case is caught within ~16s of waking.
- Capped exponential respawn backoff (2s → 60s, max 8 attempts) if cloudflared dies repeatedly.
- If cloudflared is missing entirely, the local proxy keeps serving on `127.0.0.1:<port>` and the status bar shows a distinct red **`cloudflared missing`** state with the OS-specific install command in the tooltip — usable with your own tunnel/forwarder of choice.

### Cross-platform support
- Cloudflared discovery uses `PATH` first (`where` on Windows / `which` on Unix) then well-known install locations: Homebrew, `/usr/local/bin`, `/usr/bin`, `~/.local/bin` on macOS/Linux; `Program Files\cloudflared`, `WinGet\Links`, `~\.cloudflared`, `~\scoop\shims` on Windows.
- Install-hint error message picks `brew install cloudflared` / `winget install --id Cloudflare.cloudflared` / cloudflared releases page depending on OS.

### Status bar & UX
- Click → action menu with **Copy URL & Open Models Settings**, **Refresh Tunnel URL**, **Show Logs**, **Stop Proxy**.
- Cumulative per-tunnel cost shown next to the proxy state; resets only on URL change or stop, never on each request.
- Last request's model, cache-hit %, and per-turn cost in the tooltip.

### Privacy
- Outbound OpenRouter `HTTP-Referer` / `X-Title` attribution headers default to a generic project identifier with no PII; users can override via `cursorProxy.attributionReferer` and `cursorProxy.attributionTitle`.
- The extension never writes the user's API key anywhere; the key is read per-request from the `Authorization` header Cursor sends.

### Settings
- `cursorProxy.autoStart`, `cursorProxy.port`, `cursorProxy.backgroundFallbackModel`, `cursorProxy.minMaxTokens`, `cursorProxy.use1hCache`, `cursorProxy.pinAnthropic`, `cursorProxy.attributionReferer`, `cursorProxy.attributionTitle`.
