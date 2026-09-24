export type AppRoute = "dashboard" | "guide" | "backtest" | "strategy-editor" | "donnees" | "simulation";

export function currentRoute(): AppRoute {
  const p = window.location.pathname;
  if (p === "/guide" || p.startsWith("/guide/")) return "guide";
  if (p === "/backtest" || p.startsWith("/backtest/")) return "backtest";
  if (p === "/strategy-editor" || p.startsWith("/strategy-editor/")) return "strategy-editor";
  if (p === "/donnees" || p.startsWith("/donnees/")) return "donnees";
  if (p === "/simulation" || p.startsWith("/simulation/")) return "simulation";
  return "dashboard";
}

export function navigate(
  to: "/" | "/guide" | "/backtest" | "/strategy-editor" | "/donnees" | "/simulation",
): void {
  if (window.location.pathname === to) return;
  history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Navigate with a query string (e.g. /strategy-editor?id=custom:abc).
 * The pathname must still match an AppRoute for routing to work.
 */
export function navigateWithQuery(
  to: "/" | "/guide" | "/backtest" | "/strategy-editor" | "/donnees" | "/simulation",
  query: Record<string, string>,
): void {
  const qs = new URLSearchParams(query).toString();
  const url = qs ? `${to}?${qs}` : to;
  if (window.location.pathname === to && window.location.search === (qs ? `?${qs}` : "")) return;
  history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Read query params from the current URL. */
export function queryParam(key: string): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get(key);
}