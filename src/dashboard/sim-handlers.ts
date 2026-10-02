import type { IncomingMessage, ServerResponse } from "node:http";
import { toPublicConfig } from "../config.js";
import type { PaperTradingEngine } from "../paper/engine.js";
import type { RuntimeSettingsPatch } from "../runtime-settings.js";
import { parseStrategyId } from "../strategy/ids.js";

// Handlers REST pour la simulation live (paper trading). Extraits dans un
// module dédié pour garder server.ts compact ; server.ts les branche dans son
// routeur (un `if` par route sous /api/sim/*).

export function simEngineMissing(res: ServerResponse): void {
  res.writeHead(503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Simulation engine not initialized" }));
}

export function originForbidden(res: ServerResponse): void {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
}

export function handleSimState(engine: PaperTradingEngine, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    state: engine.getState(),
    effectiveConfig: toPublicConfig(engine.getEffectiveConfig()),
    open: engine.getOpenPositions(),
    resolved: engine.getResolvedPositions().slice(0, 200),
    resting: engine.getRestingForSlug(""),
    trades: engine.getRecentTrades(100),
  }));
}

export async function handleSimControl(
  engine: PaperTradingEngine,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(req);
    const parsed = JSON.parse(body) as { enabled?: boolean };
    const enabled = Boolean(parsed.enabled);
    engine.setEnabled(enabled);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, enabled }));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: toMessage(error) }));
  }
}

export async function handleSimConfigPatch(
  engine: PaperTradingEngine,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(req);
    const parsed = JSON.parse(body) as {
      strategyId?: string;
      presetId?: string | null;
      settings?: RuntimeSettingsPatch;
      capital?: number;
    };
    engine.applyConfig({
      strategyId: parsed.strategyId ? parseStrategyId(parsed.strategyId) : undefined,
      // `presetId: null` explicite = clear du preset ; clé absente = inchangé.
      // `?? undefined` écraserait null → le clear ne fonctionnerait jamais.
      presetId: "presetId" in parsed ? parsed.presetId : undefined,
      settings: parsed.settings,
      capital: parsed.capital,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, state: engine.getState() }));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: toMessage(error) }));
  }
}

export function handleSimReset(engine: PaperTradingEngine, res: ServerResponse): void {
  const archive = engine.reset();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    state: engine.getState(),
    archived: archive.archived,
    archiveBatchId: archive.batchId,
  }));
}

export function handleSimPositions(
  engine: PaperTradingEngine,
  url: URL,
  res: ServerResponse,
): void {
  const status = url.searchParams.get("status") ?? "open";
  const open = status !== "resolved" ? engine.getOpenPositions() : [];
  const resolved = status !== "open" ? engine.getResolvedPositions().slice(0, 200) : [];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ positions: [...open, ...resolved] }));
}

export function handleSimTrades(
  engine: PaperTradingEngine,
  url: URL,
  res: ServerResponse,
): void {
  const limitRaw = Number(url.searchParams.get("limit") ?? 200);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 1000) : 200;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ trades: engine.getRecentTrades(limit) }));
}

export function handleSimResting(
  engine: PaperTradingEngine,
  url: URL,
  res: ServerResponse,
): void {
  const slug = url.searchParams.get("slug") ?? "";
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ resting: engine.getRestingForSlug(slug) }));
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 64 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** GET /api/sim/strategy-status — statut whipsaw du moteur paper (fav-band). */
export function handleSimStrategyStatus(
  engine: PaperTradingEngine | null,
  res: ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: engine?.getStrategyStatus() ?? null }));
}
