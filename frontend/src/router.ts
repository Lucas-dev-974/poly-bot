export type AppRoute = "dashboard" | "guide" | "backtest";

export function currentRoute(): AppRoute {
  const p = window.location.pathname;
  if (p === "/guide" || p.startsWith("/guide/")) return "guide";
  if (p === "/backtest" || p.startsWith("/backtest/")) return "backtest";
  return "dashboard";
}

export function navigate(to: "/" | "/guide" | "/backtest"): void {
  if (window.location.pathname === to) return;
  history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
