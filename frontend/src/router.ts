export type AppRoute = "dashboard" | "guide";

export function currentRoute(): AppRoute {
  const p = window.location.pathname;
  return p === "/guide" || p.startsWith("/guide/") ? "guide" : "dashboard";
}

export function navigate(to: "/" | "/guide"): void {
  if (window.location.pathname === to) return;
  history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
