import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { extname, join, resolve, sep } from "node:path";
import { type BotConfig, toPublicConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import { getRelayerQuota } from "../relayer-quota.js";
import { bus, type BotEvent } from "./events.js";

/**
 * Static HTML/assets + /events + /api/state + /api/db/tables + /api/relayer-quota —
 * extraits de server.ts (split incremental).
 */

/**
 * Always prefer the Vite build output (dist/dashboard/public).
 * tsx runs this file from src/dashboard/ — ./public there is a stale copy.
 */
export function resolvePublicDir(): { html: string; dir: string } {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "../../dist/dashboard/public"), // src/dashboard/server.ts
    join(here, "public"), // dist/dashboard/server.js
  ];
  for (const dir of candidates) {
    const html = join(dir, "index.html");
    if (existsSync(html)) return { html, dir };
  }
  return { html: join(candidates[0], "index.html"), dir: candidates[0] };
}

// MIME types pour les assets statiques servis depuis public/ (build Vite).
export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export async function serveHtml(
  htmlPath: string,
  res: ServerResponse,
): Promise<void> {
  try {
    const html = await readFile(htmlPath);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(html);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(
      `Failed to load dashboard: ${message}. Run npm run build:dashboard.`,
    );
  }
}

/**
 * Sert un asset statique depuis public/ (build Vite : JS/CSS hashed).
 * Sécurisé contre le path traversal : on résout le chemin et on vérifie
 * qu'il reste bien dans PUBLIC_DIR.
 */
export async function serveStatic(
  publicDir: string,
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  try {
    // Strip the leading slash: path.join on Windows treats "/assets/x" as
    // an absolute path and ignores PUBLIC_DIR.
    const relative = pathname.replace(/^\/+/, "");
    const resolved = resolve(publicDir, relative);
    const root = resolve(publicDir) + sep;
    if (resolved !== resolve(publicDir) && !resolved.startsWith(root)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    const content = await readFile(resolved);
    const mime = MIME_TYPES[extname(resolved)] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

export function handleEvents(res: ServerResponse, replay: boolean): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event: BotEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  if (replay) {
    for (const event of bus.replay()) {
      send(event);
    }
  }

  const unsubscribe = bus.subscribe(send);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

export function handleState(config: BotConfig, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      config: toPublicConfig(config),
      events: bus.replay(),
    }),
  );
}

export function handleDbTables(
  repos: Repositories | undefined,
  res: ServerResponse,
): void {
  if (!repos) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Base de données indisponible" }));
    return;
  }
  try {
    const tables = repos.db.listTableCounts();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tables }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

export function handleRelayerQuota(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ quota: getRelayerQuota() }));
}
