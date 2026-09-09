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
          <h1>Deux façons de jouer le même match</h1>
        </div>
      </header>

      <main class="guide-main">
        <GuideStack gap={20}>
          <GuideStack gap={8}>
            <p class="guide-lead">
              Arb = filet 1 contre 1 (petit gain dans tous les cas). Barbell = filet sur la moitié,
              pari sur le reste. Les deux moteurs sont interchangeables via{" "}
              <code>strategyId</code>.
            </p>
          </GuideStack>

          <GuideRow gap={20}>
            <GuideStat value="1:1" label="Arb — outsider = favori" />
            <GuideStat value="1/2" label="Barbell — ratio défaut" />
            <GuideStat value="15 min" label="Match BTC Up / Down" />
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
