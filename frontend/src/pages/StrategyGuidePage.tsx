import { For, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { TABS, type TabId } from "../guide/data";
import { ArchTab, HedgeTab, ShipTab, StoryTab, UiTab } from "../guide/GuideTabs";
import { GuidePill, GuideRow, GuideStack, GuideStat } from "../guide/GuideUi";
import { navigate } from "../router";

export function StrategyGuidePage(): JSX.Element {
  const [tab, setTab] = createSignal<TabId>("story");

  return (
    <div class="guide-page">
      <header class="guide-header">
        <div class="guide-header__left">
          <button type="button" class="btn guide-back" onClick={() => navigate("/")}>
            ← Dashboard
          </button>
          <h1>Trois moteurs, un même marché</h1>
          <a href="/backtest" class="btn guide-nav-link">
            Backtest
          </a>
        </div>
      </header>

      <main class="guide-main">
        <GuideStack gap={20}>
          <GuideStack gap={8}>
            <p class="guide-lead">
              <strong>Arb</strong> verrouille un petit gain (1:1). <strong>Barbell</strong> garde
              la moitié en pari. <strong>Edge-lead</strong> achète le favori d'abord puis hedger
              l'outsider si le prix le permet. Chaque moteur se choisit via{" "}
              <code>strategyId</code> dans la configuration.
            </p>
          </GuideStack>

          <GuideRow gap={20}>
            <GuideStat value="1:1" label="Arb — outsider = favori" />
            <GuideStat value="1/2" label="Barbell — ratio défaut" />
            <GuideStat value="Edge→" label="Edge-lead — favori d'abord" />
          </GuideRow>

          <hr class="guide-divider" />

          <GuideRow>
            <For each={TABS}>
              {(item) => (
                <GuidePill active={tab() === item.id} onClick={() => setTab(item.id)}>
                  {item.label}
                </GuidePill>
              )}
            </For>
          </GuideRow>

          {tab() === "story" && <StoryTab />}
          {tab() === "arch" && <ArchTab />}
          {tab() === "hedge" && <HedgeTab />}
          {tab() === "ui" && <UiTab />}
          {tab() === "ship" && <ShipTab />}
        </GuideStack>
      </main>
    </div>
  );
}
