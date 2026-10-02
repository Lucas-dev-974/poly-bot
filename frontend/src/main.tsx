import { Show, createSignal, lazy, onMount, Suspense } from "solid-js";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App";
import { ToastHost } from "./components/toasts/ToastHost";
import { currentRoute, type AppRoute } from "./router";
import { startSse } from "./transport/sse";
import "./styles/variables.css";
import "./styles/globals.css";
import "./styles/components.css";

// Code-splitting : chaque page lourde est un chunk séparé, chargé à la
// demande. Le dashboard (page par défaut, petit) reste eager pour un
// premier rendu immédiat ; backtest/éditeur/guide/simulation (~90 % du
// bundle) ne sont téléchargés que si visités. Le `.then(m => ({ default }))
// adapte les exports nommés au contrat de lazy() (export default).
const StrategyGuidePage = lazy(() =>
  import("./pages/StrategyGuidePage").then((m) => ({ default: m.StrategyGuidePage })),
);
const BacktestPage = lazy(() =>
  import("./pages/BacktestPage").then((m) => ({ default: m.BacktestPage })),
);
const StrategyEditorPage = lazy(() =>
  import("./pages/StrategyEditorPage").then((m) => ({ default: m.StrategyEditorPage })),
);
const DataPage = lazy(() =>
  import("./pages/DataPage").then((m) => ({ default: m.DataPage })),
);
const SimulationPage = lazy(() =>
  import("./pages/SimulationPage").then((m) => ({ default: m.SimulationPage })),
);

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

/** Montre la page cible avec fallback Suspense (chargement du chunk). */
function Page(props: { route: () => AppRoute; target: AppRoute; children: JSX.Element }) {
  return (
    <Show when={props.route() === props.target}>
      <Suspense fallback={<div class="page-loading">Chargement…</div>}>
        {props.children}
      </Suspense>
    </Show>
  );
}

function Root() {
  const [route, setRoute] = createSignal<AppRoute>(currentRoute());

  // One SSE for the whole app (dashboard + simulation share stores).
  onMount(() => {
    startSse();
  });

  onMount(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });

  return (
    <>
      <ToastHost />
      <Page route={route} target="guide">
        <StrategyGuidePage />
      </Page>
      <Page route={route} target="backtest">
        <BacktestPage />
      </Page>
      <Page route={route} target="strategy-editor">
        <StrategyEditorPage />
      </Page>
      <Page route={route} target="donnees">
        <DataPage />
      </Page>
      <Page route={route} target="simulation">
        <SimulationPage />
      </Page>
      <Show when={route() === "dashboard"}>
        <App />
      </Show>
    </>
  );
}

render(() => <Root />, root);