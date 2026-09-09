import { Show, createSignal, onMount } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App";
import { StrategyGuidePage } from "./pages/StrategyGuidePage";
import { BacktestPage } from "./pages/BacktestPage";
import { currentRoute, type AppRoute } from "./router";
import "./styles/variables.css";
import "./styles/globals.css";
import "./styles/components.css";
import "./styles/guide.css";
import "./styles/backtest.css";

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
    <Show
      when={route() === "guide"}
      fallback={
        <Show when={route() === "backtest"} fallback={<App />}>
          <BacktestPage />
        </Show>
      }
    >
      <StrategyGuidePage />
    </Show>
  );
}

render(() => <Root />, root);
