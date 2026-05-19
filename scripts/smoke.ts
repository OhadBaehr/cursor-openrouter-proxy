// Quick standalone smoke test: spin up the proxy server on :9100 and hit it
// twice with an identical Anthropic-shape body to confirm cache_read climbs.
import { startProxyServer } from "../src/proxyServer";

async function main() {
  const server = await startProxyServer({
    port: 9100,
    log: (l) => console.log(l),
    backgroundFallbackModel: "anthropic/claude-3.5-haiku",
    minMaxTokens: 16384,
    use1hCache: true,
    pinAnthropic: true,
  });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("Set OPENROUTER_API_KEY in env. Skipping cache test.");
    await server.close();
    return;
  }

  const sysBlob =
    "You are a strict assistant. Always end every response with the marker [end]. ".repeat(
      800
    );

  for (const pass of [1, 2]) {
    const body = {
      model: "anthropic/claude-haiku-4.5",
      max_tokens: 20,
      stream: true,
      system: [
        { type: "text", text: sysBlob, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: `Reply OK${pass}` }] },
      ],
    };
    console.log(`--- PASS ${pass} ---`);
    const res = await fetch(`http://127.0.0.1:9100/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    console.log(txt.slice(0, 600));
  }

  await server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
