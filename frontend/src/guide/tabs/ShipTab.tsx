import type { JSX } from "solid-js";
import {
  GuideCallout,
  GuideStack,
  GuideTable,
  GuideTodoList,
} from "../GuideUi";
import { CHART_ZONE_SEMANTICS, NEW_FILES, TODOS } from "../data";

export function ShipTab(): JSX.Element {
  return (
    <GuideStack>
      <GuideTodoList items={TODOS} />
      <h3 class="guide-h3">Fichiers nouveaux</h3>
      <GuideTable
        headers={["Concept", "Comportement"]}
        rows={CHART_ZONE_SEMANTICS}
        rowTone={CHART_ZONE_SEMANTICS.map(() => "neutral")}
      />
<GuideTable
        headers={["Chemin", "Contenu"]}
        rows={NEW_FILES}
        rowTone={NEW_FILES.map(() => "neutral")}
      />
      <h3 class="guide-h3">Fichiers à câbler (existants)</h3>
      <p>
        <code>src/bot.ts</code>, <code>src/strategy.ts</code> (barrel), <code>src/config.ts</code>,{" "}
        <code>src/runtime-settings.ts</code>, <code>src/strategy-presets.ts</code>, presets JSON,{" "}
        <code>bot-settings.example.json</code>, <code>tests/helpers.ts</code>, frontend types /{" "}
        <code>configForm.ts</code> / <code>SettingsModal</code> / <code>ConfigBar</code>,{" "}
        <code>README.md</code> / <code>STRATEGY.md</code>. Ne pas éditer le JSON live gitignored.
      </p>
      <h3 class="guide-h3">Hors scope</h3>
      <GuideTable
        headers={["Non-goal", "Pourquoi"]}
        rows={[
          ["Oracle / Kelly / EdgeModel", "Séquence 3 audit-5 — vrai B2 plus tard"],
          ["Presets barbell", "Seulement tagger les deux existants arb + edge-lead"],
          ["Nested { arb, barbell } dans un JSON", "Un preset = un moteur + settings plats"],
          ["Revalidation hedge live", "hedgeAtPostTime avant balance/buy (Policy A defend)"],
          ["Accounting covered 1:1 pour barbell", "Paires ratio < 1 restent partial / directional"],
          ["1:1 shares en edge-lead", "Budgets USDC indépendants par design"],
        ]}
        rowTone={["neutral", "neutral", "neutral", "neutral", "warning", "neutral"]}
      />
      <GuideCallout tone="info" title="Défauts">
        <p>
          JSON sans <code>strategyId</code> → arb. Id inconnu → sanitizePatch throw, live refuse
          de démarrer. <code>parseStrategyId("EDGE-LEAD")</code> → <code>"edge-lead"</code>.
        </p>
      </GuideCallout>
    </GuideStack>
  );
}

