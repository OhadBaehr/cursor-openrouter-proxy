# Cursor OpenRouter Proxy

<p align="center">
  <img src="media/icon.png" width="96" alt="Cursor OpenRouter Proxy icon"/>
</p>

A self-contained Cursor extension that lets you point Cursor at **OpenRouter** instead of Cursor's hosted models, with the prompt-caching, cost, and tool-call semantics Cursor expects — no Docker, no separate binary, no manual URL juggling.

It runs a tiny local proxy inside Cursor's extension host, exposes it via a free `cloudflared` quick-tunnel, and tells you the public base URL in the status bar.

## Why

Cursor speaks an Anthropic-style chat schema (`system` as a block array, `tool_choice` objects, `cache_control` markers). OpenRouter's `v1/chat/completions` endpoint is OpenAI-shaped and drops the cache hints. Without translation:

- Prompt caches don't form, every turn re-pays the full system-prompt token cost.
- Background "thinking" model variants Cursor sends (`…-xhigh`, `…-thinking`, etc.) 400.
- Long tool-call JSON gets truncated because Cursor's default `max_tokens` is too low.

This extension makes the OpenRouter side look the way Cursor wants it to.

## What it does

- Boots an OpenAI-compatible proxy on `127.0.0.1:9000` (configurable).
- Translates Cursor's Anthropic-shape requests to OpenRouter's `/v1/messages` so `cache_control` survives.
- Pins routing to Anthropic-direct so prompt caches don't fragment across providers.
- Upgrades the cache TTL to 1 hour so idle gaps in your chat don't kill the cache.
- Raises `max_tokens` to 16k so long tool-call payloads don't truncate ("Edit attempted" toasts).
- Demotes Cursor's background variants (`thinking`, `xhigh`, …) to a cheap Haiku.
- Spawns `cloudflared` for a free public quick-tunnel and surfaces the URL in the status bar with one-click copy + jump to **Cursor Settings → Models**.
- Polls the public tunnel and auto-rotates if it dies (the usual laptop-wake failure).

## Install

### From the Marketplace

1. **Install** *Cursor OpenRouter Proxy* from the Marketplace.
2. `brew install cloudflared` (or download from [the cloudflared releases](https://github.com/cloudflare/cloudflared/releases)).
3. Reload Cursor.

The extension auto-starts on Cursor launch. Within ~5s the status bar shows an orange `Proxy: new URL` button.

### Configure OpenRouter in Cursor

This step is one-time:

1. Click the orange status-bar button → **Copy URL & Open Models Settings**.
   The base URL (something like `https://<random-words>.trycloudflare.com/v1`) is now in your clipboard and the Models page is open.
2. Toggle **OpenAI API Key**. Paste your `sk-or-…` OpenRouter key.
3. Tick **Override OpenAI Base URL** and paste the URL from the clipboard.
4. Add a model name (e.g. `anthropic/claude-opus-4.7`) and click **Verify**.

From now on the status bar turns green and stays green until the tunnel URL changes.

## Status bar

| State | Text | Click |
| --- | --- | --- |
| Off | gray `Proxy: off` | Start the proxy + tunnel |
| Starting | spinner `Proxy: starting…` | nothing |
| Tunnel down | orange `Proxy: tunnel down` | Action menu |
| New URL not yet applied | orange `Proxy: new URL` | Action menu (top item: **Copy URL & Open Models Settings**) |
| Healthy | green `Proxy: on · $0.07` | Action menu |

The dollar amount in the healthy state is the **cumulative cost since the current tunnel started**. It resets only on a URL change or on **Stop Proxy** — it does not jump around with each new request. Tooltip shows the breakdown, the last turn's model, and the cache-hit %.

## Commands

| Command | Description |
| --- | --- |
| `Cursor Proxy: Show Menu` | Open the status-bar action menu (also fires on click). |
| `Cursor Proxy: Toggle On/Off` | Start or stop the proxy + tunnel. |
| `Cursor Proxy: Refresh Tunnel URL` | Force a new cloudflared URL. |
| `Cursor Proxy: Copy URL & Open Models Settings` | Copy `https://<random>.trycloudflare.com/v1` and deep-link to Cursor's Models page. |
| `Cursor Proxy: Show Logs` | Open the extension's output channel. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cursorProxy.autoStart` | `true` | Start automatically on Cursor launch. |
| `cursorProxy.port` | `9000` | Local TCP port to bind. |
| `cursorProxy.backgroundFallbackModel` | `anthropic/claude-3.5-haiku` | Where to send Cursor's `thinking/xhigh` variants. |
| `cursorProxy.minMaxTokens` | `16384` | Floor for `max_tokens` so long tool-call JSON survives. |
| `cursorProxy.use1hCache` | `true` | Upgrade `cache_control: ephemeral` to Anthropic's 1-hour TTL beta (2× write cost, survives idle gaps). |
| `cursorProxy.pinAnthropic` | `true` | Pin OpenRouter routing to anthropic-direct so prompt caches persist. |
| `cursorProxy.attributionReferer` | `""` | Optional override of OpenRouter's `HTTP-Referer` attribution header. Empty = generic project identifier (no PII). |
| `cursorProxy.attributionTitle` | `""` | Optional override of OpenRouter's `X-Title` attribution header. Empty = `"Cursor Proxy"`. |

## How it stays alive

- The cloudflared tunnel runs **detached** with `unref()`, so Cursor reloading the extension host doesn't restart cloudflared. On reload the extension finds the existing PID + URL via a small JSON state file under `$TMPDIR/cursor-proxy/`, adopts it, and skips re-spawning. That's why a normal reload doesn't change your URL.
- Every 30 seconds (and immediately on window focus) the extension HTTP-GETs `<tunnel>/health`. Two consecutive failures trigger a clean tunnel refresh, so the laptop-sleep failure where the process survives but the edge connection is gone gets caught within ~16 s of you returning.

## What it doesn't do

- It does **not** write to Cursor's settings store. Cursor caches `openAIBaseUrl` in renderer memory and any direct DB write gets clobbered on the next flush. That's why the workflow is "copy URL → paste in Models settings" — the only path that actually sticks.
- It does **not** require Docker. Earlier versions of this project did; this one runs the whole proxy in Cursor's extension host.

## Troubleshooting

- **Status bar says `tunnel down` after sleep.** Click it → `Refresh Tunnel URL`. The auto-refresh on focus should catch this within ~16 s anyway.
- **`cloudflared not found`.** Install via Homebrew or place the binary at `/opt/homebrew/bin/cloudflared`, `/usr/local/bin/cloudflared`, or `~/.local/bin/cloudflared`.
- **Cursor says the key didn't verify.** Make sure the URL you pasted ends in `/v1` and the API key starts with `sk-or-`.
- **Lots of `Edit attempted` toasts.** Bump `cursorProxy.minMaxTokens` higher (e.g. `32768`).

## Development

```bash
git clone https://github.com/OhadBaehr/cursor-openrouter-proxy.git
cd cursor-openrouter-proxy
npm install
npm run build       # one-shot esbuild
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
npm run package     # produces cursor-openrouter-proxy.vsix
```

`F5` in Cursor (Run Extension) launches a development host with the extension loaded.

## License

MIT — see [LICENSE](LICENSE).
