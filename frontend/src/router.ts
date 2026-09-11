export type AppRoute = "dashboard" | "guide" | "backtest" | "strategy-editor";

export function currentRoute(): AppRoute {
  const p = window.location.pathname;
  if (p === "/guide" || p.startsWith("/guide/")) return "guide";
  if (p === "/backtest" || p.startsWith("/backtest/")) return "backtest";
  if (p === "/strategy-editor" || p.startsWith("/strategy-editor/")) return "strategy-editor";
  return "dashboard";
}

export function navigate(to: "/" | "/guide" | "/backtest" | "/strategy-editor"): void {
  if (window.location.pathname === to) return;
  history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
