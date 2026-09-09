export function fmtPrice(p: number | null | undefined): string {
  return p == null ? "—" : "$" + Number(p).toFixed(2);
}

export function fmtUsd(v: number | null | undefined): string {
  return (
    "$" +
    Number(v || 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

export function fmtUsdCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v < 0 ? "-" : "";
  const n = Math.abs(v);
  if (n >= 1_000_000) return `${sign}$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${sign}$${(n / 1_000).toFixed(1)}k`;
  if (n >= 100) return `${sign}$${n.toFixed(0)}`;
  return `${sign}$${n.toFixed(2)}`;
}

export function fmtShares(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const n = Math.abs(v);
  if (n >= 100) return v.toFixed(0);
  if (n >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export function fmtSizePair(
  bid: number | null | undefined,
  ask: number | null | undefined,
): string {
  return `${fmtShares(bid)} / ${fmtShares(ask)}`;
}

export function fmtSpread(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(3);
}

export function countdown(end: number, now: number): string {
  const diff = Math.max(0, end * 1000 - now);
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function pct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

export function formatReturnPct(price: number): string {
  return `+${Math.round((1 / price - 1) * 100)}%`;
}

export function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function dateTimeStr(ts: number | undefined): string {
  if (ts == null) return "—";
  return new Date(ts).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
