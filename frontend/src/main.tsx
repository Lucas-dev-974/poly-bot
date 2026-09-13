import { Show, createSignal, onMount } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App";
import { StrategyGuidePage } from "./pages/StrategyGuidePage";
import { BacktestPage } from "./pages/BacktestPage";
import { StrategyEditorPage } from "./pages/StrategyEditorPage";
import { DataPage } from "./pages/DataPage";
import { currentRoute, type AppRoute } from "./router";
import "./styles/variables.css";
import "./styles/globals.css";
import "./styles/components.css";
import "./styles/guide.css";
import "./styles/backtest.css";
import "./styles/strategy-editor.css";
import "./styles/data.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

function Root() {
  const [route, setRoute] = createSignal<AppRoute>(currentRoute());

  onMount(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });

  return (
    <>
      <Show when={route() === "guide"}>
        <StrategyGuidePage />
      </Show>
      <Show when={route() === "backtest"}>
        <BacktestPage />
      </Show>
      <Show when={route() === "strategy-editor"}>
        <StrategyEditorPage />
      </Show>
      <Show when={route() === "donnees"}>
        <DataPage />
      </Show>
      <Show when={route() === "dashboard"}>
        <App />
      </Show>
    </>
  );
}

render(() => <Root />, root);
