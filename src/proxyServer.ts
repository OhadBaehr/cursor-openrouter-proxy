import * as http from "node:http";
import * as crypto from "node:crypto";
import { URL } from "node:url";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Background-feature model variants Cursor sends (e.g. *-thinking, *-xhigh)
// that OpenRouter doesn't recognize. Demoted to a cheap fallback.
const BG_MODEL_RE = /thinking|xhigh|xmedium|xlow|-auto\b/i;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-server",
  "x-real-ip",
]);

export interface ProxyOptions {
  port: number;
  log: (line: string) => void;
  backgroundFallbackModel: string;
  minMaxTokens: number;
  use1hCache: boolean;
  pinAnthropic: boolean;
  // OpenRouter attribution headers; default to a generic project id.
  referer?: string;
  appTitle?: string;
}

export interface UsageEvent {
  model: string;
  provider: string;
  input: number;
  cacheCreate: number;
  cacheRead: number;
  output: number;
  cost: number;
}

export interface ProxyServer {
  port: number;
  close(): Promise<void>;
  onUsage(handler: (u: UsageEvent) => void): void;
}

// True for bodies shaped like Anthropic's API: array system blocks,
// input_schema tools, or a tool_choice object.
function isAnthropicBody(body: Buffer): boolean {
  if (!body.length) return false;
  let obj: any;
  try {
    obj = JSON.parse(body.toString("utf8"));
  } catch {
    return false;
  }
  if (Array.isArray(obj?.tools)) {
    for (const t of obj.tools) {
      if (t && t.input_schema && t.type !== "function" && !t.function) {
        return true;
      }
    }
  }
  const tc = obj?.tool_choice;
  if (tc && typeof tc === "object" && !Array.isArray(tc)) {
    if (["auto", "any", "tool"].includes(tc.type)) return true;
  }
  if (Array.isArray(obj?.system)) return true;
  return false;
}

function newChatId(): string {
  return "chatcmpl-" + crypto.randomBytes(12).toString("hex");
}

function mapStopReason(r: string | undefined): string {
  switch (r) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "end_turn":
    case "stop_sequence":
    case "":
    case undefined:
      return "stop";
  }
  return "stop";
}

function cleanAnthropicBody(body: Buffer, opts: ProxyOptions): Buffer<ArrayBufferLike> {
  let obj: any;
  try {
    obj = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }

  // Strip OpenAI-only fields that /v1/messages rejects.
  for (const k of [
    "stream_options",
    "parallel_tool_calls",
    "n",
    "logprobs",
    "frequency_penalty",
    "presence_penalty",
    "response_format",
  ]) {
    delete obj[k];
  }

  // Cursor's default max_tokens truncates long tool-call JSON. Billing is
  // per emitted token, not per cap, so raising the floor is free.
  if (typeof obj.max_tokens !== "number" || obj.max_tokens < opts.minMaxTokens) {
    obj.max_tokens = opts.minMaxTokens;
  }

  // Pin OpenRouter routing to Anthropic-direct so prompt caches stick.
  if (opts.pinAnthropic && !obj.provider) {
    obj.provider = { order: ["anthropic"], allow_fallbacks: false };
  }

  let out = JSON.stringify(obj);
  if (opts.use1hCache) {
    out = out.split('"cache_control":{"type":"ephemeral"}').join(
      '"cache_control":{"type":"ephemeral","ttl":"1h"}'
    );
  }
  return Buffer.from(out, "utf8");
}

function rewriteModel(body: Buffer, newModel: string): Buffer<ArrayBufferLike> {
  try {
    const obj = JSON.parse(body.toString("utf8"));
    obj.model = newModel;
    return Buffer.from(JSON.stringify(obj), "utf8");
  } catch {
    return body;
  }
}

interface UsageAcc {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  cost: number;
}

interface BlockState {
  kind: "text" | "tool_use";
  openAIToolIdx: number;
  toolID?: string;
  toolName?: string;
}

// Re-emit an Anthropic /v1/messages SSE stream as OpenAI chat.completion.chunk
// SSE, returning final usage.
async function streamAnthropicAsOpenAI(
  upstream: http.IncomingMessage,
  res: http.ServerResponse
): Promise<{ model: string; provider: string; usage: UsageAcc }> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.writeHead(200);

  const chatID = newChatId();
  const created = Math.floor(Date.now() / 1000);
  let model = "";
  let provider = "";
  const blocks = new Map<number, BlockState>();
  let nextToolIdx = 0;
  let roleSent = false;
  let stopReason = "";
  const usage: UsageAcc = {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    cost: 0,
  };

  function emit(delta: any, finish: string | null = null) {
    const chunk = {
      id: chatID,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finish,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  function handleEvent(ev: any) {
    switch (ev.type) {
      case "message_start": {
        const m = ev.message ?? {};
        if (m.model) model = m.model;
        if (m.provider) provider = m.provider;
        const u = m.usage ?? {};
        if (u.input_tokens) usage.input = u.input_tokens;
        if (u.cache_creation_input_tokens)
          usage.cacheCreate = u.cache_creation_input_tokens;
        if (u.cache_read_input_tokens)
          usage.cacheRead = u.cache_read_input_tokens;
        if (!roleSent) {
          emit({ role: "assistant", content: "" });
          roleSent = true;
        }
        break;
      }
      case "content_block_start": {
        const cb = ev.content_block ?? {};
        if (cb.type === "text") {
          blocks.set(ev.index, { kind: "text", openAIToolIdx: -1 });
        } else if (cb.type === "tool_use") {
          const st: BlockState = {
            kind: "tool_use",
            openAIToolIdx: nextToolIdx++,
            toolID: cb.id,
            toolName: cb.name,
          };
          blocks.set(ev.index, st);
          emit({
            tool_calls: [
              {
                index: st.openAIToolIdx,
                id: st.toolID,
                type: "function",
                function: { name: st.toolName, arguments: "" },
              },
            ],
          });
        }
        break;
      }
      case "content_block_delta": {
        const st = blocks.get(ev.index);
        if (!st) return;
        const d = ev.delta ?? {};
        if (d.type === "text_delta" && st.kind === "text" && d.text) {
          emit({ content: d.text });
        } else if (d.type === "thinking_delta" && d.thinking) {
          emit({ reasoning_content: d.thinking });
        } else if (
          d.type === "input_json_delta" &&
          st.kind === "tool_use" &&
          d.partial_json
        ) {
          emit({
            tool_calls: [
              {
                index: st.openAIToolIdx,
                function: { arguments: d.partial_json },
              },
            ],
          });
        }
        break;
      }
      case "content_block_stop":
        blocks.delete(ev.index);
        break;
      case "message_delta": {
        const d = ev.delta ?? {};
        if (d.stop_reason) stopReason = d.stop_reason;
        const u = ev.usage ?? {};
        if (u.input_tokens) usage.input = u.input_tokens;
        if (u.output_tokens) usage.output = u.output_tokens;
        if (u.cache_creation_input_tokens)
          usage.cacheCreate = u.cache_creation_input_tokens;
        if (u.cache_read_input_tokens)
          usage.cacheRead = u.cache_read_input_tokens;
        if (typeof u.cost === "number") usage.cost = u.cost;
        break;
      }
      case "message_stop": {
        emit({}, mapStopReason(stopReason));
        res.write("data: [DONE]\n\n");
        res.end();
        break;
      }
    }
  }

  return new Promise((resolve) => {
    let buf = "";
    upstream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          handleEvent(JSON.parse(payload));
        } catch {
          // ignore malformed event
        }
      }
    });
    upstream.on("end", () => {
      if (!res.writableEnded) {
        emit({}, mapStopReason(stopReason));
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve({ model, provider, usage });
    });
    upstream.on("error", () => {
      if (!res.writableEnded) res.end();
      resolve({ model, provider, usage });
    });
  });
}

async function bufferedAnthropicAsOpenAI(
  upstream: http.IncomingMessage,
  res: http.ServerResponse
): Promise<{ model: string; provider: string; usage: UsageAcc }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    upstream.on("data", (c: Buffer) => chunks.push(c));
    upstream.on("end", () => {
      const raw = Buffer.concat(chunks);
      let msg: any;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        res.setHeader(
          "Content-Type",
          upstream.headers["content-type"] || "application/json"
        );
        res.writeHead(upstream.statusCode || 200);
        res.end(raw);
        resolve({
          model: "",
          provider: "",
          usage: {
            input: 0,
            output: 0,
            cacheCreate: 0,
            cacheRead: 0,
            cost: 0,
          },
        });
        return;
      }
      const textParts: string[] = [];
      const toolCalls: any[] = [];
      for (const b of msg.content ?? []) {
        if (b.type === "text") textParts.push(b.text ?? "");
        else if (b.type === "tool_use") {
          let args = "{}";
          try {
            args = JSON.stringify(b.input ?? {});
          } catch {
            /* ignore */
          }
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: args },
          });
        }
      }
      const u = msg.usage ?? {};
      const usage: UsageAcc = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cost: typeof u.cost === "number" ? u.cost : 0,
      };
      const out: any = {
        id: newChatId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: msg.model,
        choices: [
          {
            index: 0,
            finish_reason: mapStopReason(msg.stop_reason),
            message: {
              role: "assistant",
              content: textParts.join("\n"),
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
        usage: {
          prompt_tokens: usage.input + usage.cacheCreate + usage.cacheRead,
          completion_tokens: usage.output,
          total_tokens:
            usage.input + usage.cacheCreate + usage.cacheRead + usage.output,
          prompt_tokens_details: { cached_tokens: usage.cacheRead },
        },
      };
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify(out));
      resolve({ model: msg.model ?? "", provider: msg.provider ?? "", usage });
    });
    upstream.on("error", () => {
      if (!res.writableEnded) res.end();
      resolve({
        model: "",
        provider: "",
        usage: {
          input: 0,
          output: 0,
          cacheCreate: 0,
          cacheRead: 0,
          cost: 0,
        },
      });
    });
  });
}

export async function startProxyServer(
  opts: ProxyOptions
): Promise<ProxyServer> {
  const usageHandlers: ((u: UsageEvent) => void)[] = [];

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, Content-Type, Accept, Authorization"
    );
    res.setHeader("Access-Control-Expose-Headers", "Content-Length");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(`{"status":"ok"}`);
      return;
    }
    if (!url.pathname.startsWith("/v1/") && url.pathname !== "/v1") {
      res.writeHead(404);
      res.end("Not found. Use /v1 as the OpenAI base URL.");
      return;
    }

    const authHeader = req.headers["authorization"];
    if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
      res.writeHead(401);
      res.end("Missing Authorization header.");
      return;
    }
    const upstreamKey = authHeader.slice("Bearer ".length).trim();
    if (!upstreamKey.startsWith("sk-or-")) {
      res.writeHead(401);
      res.end("Set your OpenRouter API key (sk-or-...) in Cursor.");
      return;
    }

    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) bodyChunks.push(chunk as Buffer);
    let body: Buffer = Buffer.concat(bodyChunks);

    let bodyModel = "";
    try {
      bodyModel = JSON.parse(body.toString("utf8")).model || "";
    } catch {
      /* ignore */
    }
    const bp = (body.toString("utf8").match(/"cache_control"/g) || []).length;

    if (bodyModel && BG_MODEL_RE.test(bodyModel)) {
      body = rewriteModel(body, opts.backgroundFallbackModel);
      opts.log(
        `[demote] ${bodyModel} → ${opts.backgroundFallbackModel} (Cursor background variant)`
      );
      bodyModel = opts.backgroundFallbackModel;
    }

    opts.log(
      `[req] ${req.method} ${url.pathname} size=${body.length}B model=${bodyModel} cache_breakpoints=${bp}`
    );

    let subPath = url.pathname.replace(/^\/v1/, "");
    let useMessagesEndpoint = false;
    if (subPath === "/chat/completions" && isAnthropicBody(body)) {
      body = cleanAnthropicBody(body, opts);
      subPath = "/messages";
      useMessagesEndpoint = true;
      opts.log("Anthropic-shape request → /v1/messages (cache_control preserved)");
    }

    const target = OPENROUTER_BASE + subPath + (url.search || "");
    opts.log(`Forwarding ${req.method} ${url.pathname} -> ${target}`);

    const forwardHeaders: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      forwardHeaders[k] = v as any;
    }
    forwardHeaders["authorization"] = `Bearer ${upstreamKey}`;
    forwardHeaders["host"] = "openrouter.ai";
    forwardHeaders["content-length"] = body.length.toString();
    // Force identity encoding so we don't have to gunzip on every chunk.
    forwardHeaders["accept-encoding"] = "identity";
    // Default attribution headers are a generic project id, not per-user.
    if (!forwardHeaders["http-referer"]) {
      forwardHeaders["http-referer"] =
        opts.referer && opts.referer.trim().length > 0
          ? opts.referer.trim()
          : "cursor-openrouter-proxy";
    }
    if (!forwardHeaders["x-title"]) {
      forwardHeaders["x-title"] =
        opts.appTitle && opts.appTitle.trim().length > 0
          ? opts.appTitle.trim()
          : "Cursor Proxy";
    }
    if (useMessagesEndpoint && opts.use1hCache) {
      forwardHeaders["anthropic-beta"] = "extended-cache-ttl-2025-04-11";
    }

    const targetUrl = new URL(target);
    const https = require("node:https") as typeof import("node:https");
    const upstreamReq = https.request(
      {
        method: req.method,
        hostname: targetUrl.hostname,
        port: targetUrl.port || 443,
        path: targetUrl.pathname + targetUrl.search,
        headers: forwardHeaders,
      },
      async (upstream) => {
        opts.log(
          `Upstream ${upstream.statusCode} ${upstream.headers["content-type"] || ""}`
        );

        // Translate Anthropic /messages success back to OpenAI shape.
        if (
          useMessagesEndpoint &&
          upstream.statusCode &&
          upstream.statusCode < 400
        ) {
          const ct = (upstream.headers["content-type"] as string) || "";
          let result: { model: string; provider: string; usage: UsageAcc };
          if (ct.startsWith("text/event-stream")) {
            result = await streamAnthropicAsOpenAI(upstream, res);
          } else {
            result = await bufferedAnthropicAsOpenAI(upstream, res);
          }
          const total =
            result.usage.input + result.usage.cacheCreate + result.usage.cacheRead;
          const pct = total > 0 ? (100 * result.usage.cacheRead) / total : 0;
          opts.log(
            `[usage] model=${result.model} provider=${result.provider} ` +
              `input=${result.usage.input} cache_create=${result.usage.cacheCreate} ` +
              `cache_read=${result.usage.cacheRead} output=${result.usage.output} ` +
              `(cached=${pct.toFixed(1)}%) cost=$${result.usage.cost.toFixed(4)}`
          );
          for (const h of usageHandlers) {
            try {
              h({
                model: result.model,
                provider: result.provider,
                input: result.usage.input,
                cacheCreate: result.usage.cacheCreate,
                cacheRead: result.usage.cacheRead,
                output: result.usage.output,
                cost: result.usage.cost,
              });
            } catch {
              /* ignore handler errors */
            }
          }
          return;
        }

        for (const [k, v] of Object.entries(upstream.headers)) {
          if (HOP_BY_HOP.has(k.toLowerCase())) continue;
          if (v !== undefined) res.setHeader(k, v as any);
        }
        res.writeHead(upstream.statusCode || 502);
        upstream.pipe(res);
      }
    );
    upstreamReq.on("error", (err) => {
      opts.log(`upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("Bad gateway: upstream request failed.");
      }
    });
    upstreamReq.write(body);
    upstreamReq.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  opts.log(`Starting proxy server on 127.0.0.1:${opts.port}`);

  return {
    port: opts.port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    onUsage(h) {
      usageHandlers.push(h);
    },
  };
}
