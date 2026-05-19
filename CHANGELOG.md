# Changelog

All notable changes to this extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
