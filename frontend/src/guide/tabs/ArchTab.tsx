import type { JSX } from "solid-js";
import { FlowDag } from "../Diagrams";
import {
  GuideCallout,
  GuideCard,
  GuideGrid,
  GuideStack,
  GuideTable,
} from "../GuideUi";
import { API_ROWS } from "../data";

export function ArchTab(): JSX.Element {
  return (
    <GuideStack>
      <p>
        Aujourd'hui <code>SizingStrategy</code> ne calcule que les tailles. Le <em>quand</em>{" "}
        poster, hedger, reprice ou défendre est dispersé dans <code>src/strategy.ts</code> et{" "}
        <code>src/bot.ts</code>. Le plan sort <strong>toute la politique</strong> dans une classe{" "}
        <code>TradingStrategy</code> ; le bot n'exécute plus que CLOB, soldes, exposition,
        tracker.
      </p>
      <GuideCard title="Flux d'un tick (inchangé côté exécution)">
        <GuideStack gap={10}>
          <FlowDag />
          <p class="guide-muted guide-small">
            Production : <code>this.strategy</code> via <code>createStrategy(config.strategyId)</code>
            . Onze moteurs natifs : <code>arb</code>, <code>barbell</code>, <code>edge-lead</code>,{" "}
            <code>reverse</code>, <code>dip-revert</code>, <code>fav-band</code>,{" "}
            <code>antiflip-revert</code>, <code>flip-confirm</code>,{" "}
            <code>early-conviction</code>, <code>open-entry</code>,{" "}
            <code>probability-repricing</code> (+ <code>custom:…</code> graph). Le
            barrel <code>findOpportunities()</code> reste <strong>arb-only</strong> pour les tests
            existants.
          </p>
        </GuideStack>
      </GuideCard>
      <GuideGrid columns={5}>
        <GuideCard title="Arb / Barbell" trailing={<span class="guide-tag">cheap-first</span>}>
          <GuideStack gap={6}>
            <p>Picks cheap / favori via orchestrate</p>
            <p>Lock pairLockMax (arb) ou ratio (barbell)</p>
            <p>Hedge au POST + défense FOK SELL</p>
          </GuideStack>
        </GuideCard>
        <GuideCard title="Edge-lead" trailing={<span class="guide-tag">edge-first</span>}>
          <GuideStack gap={6}>
            <p>Confirmation edge + GTC favori</p>
            <p>Cheap après fill, bandes séparées</p>
            <p>Pas de hedgeAtPostTime ni défense</p>
          </GuideStack>
        </GuideCard>
        <GuideCard title="Reverse" trailing={<span class="guide-tag">contre-foule</span>}>
            <GuideStack gap={6}>
              <p>Grilles maker underdog + favori (simultanées)</p>
              <p>Sizing budget USDC par niveau</p>
              <p>Pas de C2 / lock / défense — espérance</p>
            </GuideStack>
          </GuideCard>
          <GuideCard title="Dip-revert" trailing={<span class="guide-tag">mean-reversion</span>}>
            <GuideStack gap={6}>
              <p>FOK favori après chute + rebond</p>
              <p>Sizing budget USDC unique</p>
              <p>Pas de hedge / défense — hold résolution</p>
            </GuideStack>
          </GuideCard>
          <GuideCard title="Exécution" trailing={<span class="guide-tag">bot</span>}>
          <GuideStack gap={6}>
            <p>Scan, tick, pause, READONLY_LIVE</p>
            <p>Place / cancel / poll, confirmation tokens</p>
            <p>Collatéral, exposition, tracker, DB</p>
          </GuideStack>
        </GuideCard>
      </GuideGrid>
      <GuideCallout tone="warning" title="Cycle d'imports">
        <p>
          <code>arb-strategy.ts</code> / <code>barbell-strategy.ts</code> /{" "}
          <code>edge-lead-strategy.ts</code> / <code>reverse-strategy.ts</code> /{" "}
          <code>orchestrate.ts</code> n'importent pas{" "}
          <code>src/strategy.ts</code>. Pas de <code>src/strategy/index.ts</code> (le dossier
          existe déjà).
        </p>
      </GuideCallout>
      <h3 class="guide-h3">API TradingStrategy</h3>
      <GuideTable
        headers={["Méthode", "Rôle"]}
        rows={API_ROWS}
        rowTone={API_ROWS.map(() => "neutral")}
      />
    </GuideStack>
  );
}

