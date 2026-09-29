/**
 * Phase 0 / Task 0.4 — Accessibilité WS Binance (geo-block 451) + WebSocket
 * global Node 22 (zéro nouvelle dépendance).
 *
 * Teste les endpoints du fallback v1 :
 *   1. WS spot `btcusdt@trade` / `ethusdt@trade` (flux 1s du plan)
 *   2. WS combiné `btcusdt@trade/ethusdt@trade` (2 symboles, 1 socket)
 *   3. miniTicker (repli si trade throttled)
 * puis vérifie `globalThis.WebSocket` (Node 22, stable, sans dep).
 *
 * Sortie : audits/chainlink-lag/A5-WS-<stamp>.md
 *
 *   npx tsx scripts/research/chainlink-lag/03-ws-binance.mts
 *   Env: DURATION_MS=30000
 */
import { mkdirSync, writeFileSync } from "node:fs";

const DURATION_MS = Number(process.env.DURATION_MS ?? 30_000);
const OUT_DIR = "audits/chainlink-lag";

// ── 1. WebSocket global Node 22 ? ────────────────────────────────────────────
const wsGlobal = typeof globalThis.WebSocket === "function";
console.log(`globalThis.WebSocket (Node 22): ${wsGlobal ? "OK" : "ABSENT — ajouter 'ws' aux deps"}`);

// ── 2. Sonde WS ──────────────────────────────────────────────────────────────
interface ProbeResult {
  name: string;
  url: string;
  ok: boolean;
  detail: string;
  messages: number;
  latencyMs: number | null;
}

function probeWs(
  name: string,
  url: string,
  payload: string,
  match: (data: Record<string, unknown>) => boolean,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const result: ProbeResult = { name, url, ok: false, detail: "", messages: 0, latencyMs: null };
    let ws: WebSocket | null = null;
    const started = Date.now();
    let settled = false;
    const finish = (detail?: string) => {
      if (settled) return;
      settled = true;
      if (detail && !result.ok) result.detail = detail;
      clearTimeout(timeout);
      try { ws?.close(); } catch { /* déjà fermé */ }
      resolve(result);
    };
    const timeout = setTimeout(() => finish(`timeout ${DURATION_MS}ms sans message apparié`), DURATION_MS);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      finish(`constructeur: ${String(err)}`);
      return;
    }

    ws.onopen = () => {
      result.latencyMs = Date.now() - started;
      try {
        ws?.send(payload);
      } catch (err) {
        finish(`send: ${String(err)}`);
      }
    };
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (match(data)) {
          result.ok = true;
          result.messages++;
          result.detail = "stream OK";
          finish();
        }
      } catch {
        /* ignorer les messages non JSON */
      }
    };
    ws.onerror = () => {
      if (!result.ok) finish(result.detail || "onerror (souvent geo-block 451 / réseau)");
    };
    ws.onclose = (ev: CloseEvent) => {
      if (!result.ok) finish(`close code=${ev.code ?? "?"} ${result.detail}`.trim());
    };
  });
}

async function main(): Promise<void> {
  const probes: Array<ProbeResult> = [];

  probes.push(
    await probeWs(
      "spot btcusdt@trade",
      "wss://stream.binance.com:9443/ws/btcusdt@trade",
      JSON.stringify({ method: "SUBSCRIBE", params: ["btcusdt@trade"], id: 1 }),
      (d) => d.e === "trade" && d.s === "BTCUSDT",
    ),
  );
  probes.push(
    await probeWs(
      "spot ethusdt@trade",
      "wss://stream.binance.com:9443/ws/ethusdt@trade",
      JSON.stringify({ method: "SUBSCRIBE", params: ["ethusdt@trade"], id: 1 }),
      (d) => d.e === "trade" && typeof d.p === "string",
    ),
  );
  probes.push(
    await probeWs(
      "miniTicker btcusdt",
      "wss://stream.binance.com:9443/ws/btcusdt@miniTicker",
      JSON.stringify({ method: "SUBSCRIBE", params: ["btcusdt@miniTicker"], id: 2 }),
      (d) => d.e === "24hrMiniTicker" && typeof d.c === "string",
    ),
  );
  probes.push(
    await probeWs(
      "combiné btc+eth trade",
      "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade",
      JSON.stringify({ method: "SUBSCRIBE", params: ["btcusdt@trade", "ethusdt@trade"], id: 2 }),
      (d) => (d as { stream?: string }).stream === "ethusdt@trade",
    ),
  );

  const binanceWsOk = probes.some((p) => p.ok);

  const lines: string[] = [];
  lines.push("# A5 — WS Binance + WebSocket Node 22");
  lines.push("");
  lines.push(`- Généré: ${new Date().toISOString()}`);
  lines.push(`- Node: ${process.version}`);
  lines.push(`- globalThis.WebSocket: ${wsGlobal ? "présent (zéro nouvelle dépendance)" : "**ABSENT** — ajouter 'ws' aux dependencies"}`);
  lines.push("");
  lines.push("## Sondes WS");
  lines.push("");
  lines.push("| Sonde | OK | Latence | Messages | Détail |");
  lines.push("|---|---|---|---|---|");
  for (const p of probes) {
    lines.push(`| ${p.name} | ${p.ok ? "✅" : "❌"} | ${p.latencyMs ?? "—"} ms | ${p.messages} | ${p.detail} |`);
  }
  lines.push("");

  lines.push("## Verdict A5");
  lines.push("");
  if (binanceWsOk && wsGlobal) {
    lines.push("**OK** — WS Binance accessible (pas de geo-block 451) + WebSocket global Node 22 : le feed v1 (fallback Binance) est viable sans nouvelle dépendance.");
  } else if (binanceWsOk && !wsGlobal) {
    lines.push("**OK AVEC DEP** — WS accessible mais WebSocket global absent : ajouter `ws` aux dependencies (plan Task 0.4).");
  } else {
    lines.push("**NOK** — WS Binance injoignable (geo-block 451 probable) : repli = polling REST klines 1s (plus lourd, acceptable v1) ou perps WS Polymarket en primaire.");
  }
  lines.push("");

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now();
  writeFileSync(`audits/chainlink-lag/A5-WS-${stamp}.md`, lines.join("\n"));
  writeFileSync(
    `audits/chainlink-lag/A5-WS-${stamp}.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), probes }, null, 2),
  );
  console.log(lines.join("\n"));
  console.log(`\nÉcrit: audits/chainlink-lag/A5-WS-${stamp}.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});