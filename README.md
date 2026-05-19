# Cursor OpenRouter Proxy

<p align="center">
  <img src="media/icon.png" width="96" alt="Cursor OpenRouter Proxy icon"/>
</p>

Point Cursor at **OpenRouter** without losing prompt caching, tool calls, or your sanity. The extension runs a tiny OpenAI-compatible proxy inside Cursor's extension host, exposes it via a free `cloudflared` quick-tunnel, and gives you a one-click button to plug the resulting URL into Cursor's Models settings.

No Docker, no separate binary, no manual URL editing.

## Why

Cursor sends Anthropic-shape chat requests (`system` as a block array, `tool_choice` objects, `cache_control` markers). OpenRouter's `v1/chat/completions` is OpenAI-shaped and drops the cache hints. Plug Cursor straight into OpenRouter and:

- Prompt caches never form — every turn re-pays the full system-prompt token cost.
- Cursor's background "thinking" model variants (`…-xhigh`, `…-thinking`, …) return 400.
- Long tool-call JSON gets truncated because Cursor's default `max_tokens` is too low.

This extension translates between the two, with cache pinning, TTL upgrades, and background-variant fallback, so Cursor "just works" on OpenRouter.

## Quickstart

### 1. Get the prerequisites

- An **OpenRouter API key** (`sk-or-…`) — sign up at <https://openrouter.ai/>, add some credit, copy the key.
- **cloudflared** installed and on your `PATH`:

  | OS | Install command |
  | --- | --- |
  | macOS | `brew install cloudflared` |
  | Windows | `winget install --id Cloudflare.cloudflared` (or `scoop install cloudflared`) |
  | Linux | `sudo apt install cloudflared` / `sudo dnf install cloudflared` / [official binaries](https://github.com/cloudflare/cloudflared/releases) |

  The extension also checks well-known install locations on each OS (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `~/.local/bin` on macOS/Linux; `Program Files\cloudflared`, `LOCALAPPDATA\Microsoft\WinGet\Links`, `~\.cloudflared`, `~\scoop\shims` on Windows), so a non-PATH install still works.

### 2. Install the extension

Install **Cursor OpenRouter Proxy** from the Marketplace, then reload Cursor.

On launch the extension auto-starts the local proxy and spins up a public tunnel. Within ~5 seconds the status bar shows:

> 🟧 `Proxy: new URL`

That's the cue that there's a fresh tunnel URL waiting to be applied.

### 3. Wire it up in Cursor's Models settings

This is the one-time setup. **Follow the steps in order.**

1. **Click the orange `Proxy: new URL` button → `Copy URL & Open Models Settings`.**
   - The public proxy URL — something like `https://floral-koala-banana.trycloudflare.com/v1` — is now in your clipboard.
   - Cursor's **Settings → Models** page just opened.

2. **Scroll down to the `OpenAI API Key` section.**
   - Toggle it **on**.
   - In the `OpenAI API Key` input, paste your **OpenRouter** key (`sk-or-…`). Yes, an OpenRouter key in the OpenAI field — Cursor doesn't care, the proxy translates the protocol.
   - Tick **Override OpenAI Base URL** and paste the URL from your clipboard (the `https://….trycloudflare.com/v1` one). Make sure it ends in `/v1`.

3. **Add the models you actually want to use.**
   - At the top of the Models page, click **`+ Add Custom Model`**.
   - Type the model name **exactly as it appears on OpenRouter** — e.g.
     `anthropic/claude-opus-4.7`,
     `anthropic/claude-sonnet-4.5`,
     `openai/gpt-5`,
     `google/gemini-2.5-pro`.
     Browse <https://openrouter.ai/models> and copy the slug from each model's page.
   - Press Enter to add it. Repeat for every model you want available in chat.

4. **Confirm the key was accepted.**
   - On older Cursor builds (≤ 2.0.51) you'll see a **Verify** button — click it, it should turn green.
   - On newer Cursor builds (≥ 2.0.52) there is no Verify button — Cursor now validates the key **silently** when the OpenAI toggle is on. Wait ~5 seconds, then check that your custom models appear in the model dropdown in chat. If they do, validation passed.

5. **Open a chat**, pick one of the custom models from the dropdown, and send a message. The status bar will turn green and start showing your running spend:

   > 🟢 `Proxy: on · $0.0142`

You're done. From now on every new chat goes through the proxy.

> **Tip:** if Cursor still shows its own model names (gpt-5, claude-4-opus, …), turn those off in the same Models page so the dropdown isn't cluttered. Only the custom models you added will work via the proxy.

### Renewing the URL

Cloudflare's free quick-tunnels rotate their URL every time `cloudflared` restarts. The extension keeps the tunnel alive across Cursor reloads, but when the URL does change (laptop sleep + wake, manual refresh, your network going down) the status bar turns orange again. Just click → **Copy URL & Open Models Settings** → repaste into the Base URL field. The extension auto-detects stale tunnels via a 30-second health check and on every window focus, so you'll usually see the orange before you notice a broken request.

## Status bar reference

| State | Text | Click |
| --- | --- | --- |
| Off | ⚪ `Proxy: off` | Start the proxy + tunnel |
| Starting | ⏳ `Proxy: starting…` | nothing |
| Tunnel down | 🟧 `Proxy: tunnel down` | Action menu |
| New URL not yet applied | 🟧 `Proxy: new URL` | Action menu — top item is **Copy URL & Open Models Settings** |
| Healthy | 🟢 `Proxy: on · $0.07` | Action menu |

The dollar amount is the **cumulative spend for the active tunnel session**. It only resets when the tunnel URL changes or you stop the proxy. Tooltip shows the last request's model, cache-hit %, and cost breakdown.

## Commands

| Command | Description |
| --- | --- |
| `Cursor Proxy: Show Menu` | Open the status-bar action menu (same as clicking it). |
| `Cursor Proxy: Toggle On/Off` | Start or stop the proxy + tunnel. |
| `Cursor Proxy: Refresh Tunnel URL` | Force a new cloudflared URL. |
| `Cursor Proxy: Copy URL & Open Models Settings` | Copy `https://….trycloudflare.com/v1` to clipboard and deep-link to Cursor's Models page. |
| `Cursor Proxy: Show Logs` | Open the extension's output channel. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cursorProxy.autoStart` | `true` | Start automatically on Cursor launch. |
| `cursorProxy.port` | `9000` | Local TCP port to bind. |
| `cursorProxy.backgroundFallbackModel` | `anthropic/claude-3.5-haiku` | Where to send Cursor's `thinking/xhigh` background variants. |
| `cursorProxy.minMaxTokens` | `16384` | Floor for `max_tokens` so long tool-call JSON survives. |
| `cursorProxy.use1hCache` | `true` | Upgrade `cache_control: ephemeral` to Anthropic's 1-hour TTL beta (2× write cost, survives idle gaps). |
| `cursorProxy.pinAnthropic` | `true` | Pin OpenRouter routing to anthropic-direct so prompt caches persist. |
| `cursorProxy.attributionReferer` | `""` | Optional override of OpenRouter's `HTTP-Referer` attribution header. Empty = generic project identifier (no PII). |
| `cursorProxy.attributionTitle` | `""` | Optional override of OpenRouter's `X-Title` attribution header. Empty = `"Cursor Proxy"`. |

## Troubleshooting

**Cursor says the key didn't verify (or no models appear in the dropdown after waiting).**
- Make sure the URL you pasted ends in `/v1` (not just `…trycloudflare.com`).
- Make sure the key starts with `sk-or-`. If you used an OpenAI key by mistake, the proxy will reject it with `401 Set your OpenRouter API key`.
- Make sure the custom model name exactly matches an OpenRouter slug (case-sensitive, including the provider prefix like `anthropic/`).
- Newer Cursor versions (≥ 2.0.52) removed the explicit Verify button and validate silently. If your custom models don't show up in the chat dropdown after ~5 seconds, toggle the OpenAI API Key switch off and on again to retrigger validation.

**Lots of `Edit attempted` toasts in long agent runs.**
- Bump `cursorProxy.minMaxTokens` higher (e.g. `32768`) — Cursor is truncating tool-call JSON.

**Status bar stuck on `tunnel down` after laptop wake.**
- The on-focus health check should catch this within ~16 seconds. If it doesn't, click → **Refresh Tunnel URL**.

**`cloudflared not found` in the status-bar tooltip.**
- Install it via your OS's package manager (see the [Quickstart](#1-get-the-prerequisites) table) or place the binary on your `PATH`. Running `cloudflared --version` from a fresh terminal should print the version.

**Models with `cache_control` aren't caching.**
- Check the output channel (`Cursor Proxy: Show Logs`) — every request logs the cache breakpoints and the `cached=X%` ratio. If breakpoints reach 0 the proxy is stripping them; open an issue.

## How it stays alive

- The cloudflared tunnel runs **detached** with `unref()`, so Cursor reloading the extension host doesn't restart it. On reload the extension finds the existing PID + URL via a JSON state file under the OS temp directory (`$TMPDIR/cursor-proxy/` on macOS/Linux, `%TEMP%\cursor-proxy\` on Windows), adopts it, and skips re-spawning. That's why a normal reload doesn't change your URL.
- Every 30 seconds (and immediately on window focus) the extension HTTP-GETs `<tunnel>/health`. Two consecutive failures trigger a clean tunnel refresh.

## What it deliberately doesn't do

- **It doesn't write to Cursor's settings store.** Cursor caches `openAIBaseUrl` in renderer memory and any direct DB write gets clobbered on the next flush. That's why the workflow is "copy URL → paste in Models settings" — the only path that actually sticks.
- **It doesn't require Docker.** Earlier prototypes did; this version runs the whole proxy in Cursor's extension host.

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

`F5` in Cursor (Run Extension) launches a dev host with the extension loaded.

## License

MIT — see [LICENSE](LICENSE).
