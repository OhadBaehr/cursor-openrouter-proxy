# Changelog

All notable changes to this extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-19

First public release.

- In-process OpenAI-compatible proxy that translates Cursor's Anthropic-shape requests to OpenRouter's `/v1/messages` so `cache_control` survives.
- Pins routing to Anthropic-direct so prompt caches don't fragment across providers.
- Upgrades the cache TTL to 1 hour so idle gaps don't kill the cache.
- Raises `max_tokens` to 16k so long tool-call payloads don't truncate.
- Demotes Cursor's background variants (`thinking`, `xhigh`, …) to a cheap configurable fallback model.
- Spawns `cloudflared` for a free public quick-tunnel; survives extension-host reloads by adopting the running process via on-disk state.
- Status bar shows tunnel state, cumulative per-tunnel cost, and a click-menu with **Copy URL & Open Models Settings**.
- Periodic HTTP health check of the public tunnel (30s + on window focus) auto-rotates dead tunnels after consecutive failures.
- Outbound `HTTP-Referer` / `X-Title` headers default to a generic project identifier; users can override via `cursorProxy.attributionReferer` and `cursorProxy.attributionTitle` settings.
