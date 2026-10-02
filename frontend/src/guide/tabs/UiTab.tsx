import type { JSX } from "solid-js";
import {
  GuideCallout,
  GuideCard,
  GuideGrid,
  GuideStack,
  GuideTable,
} from "../GuideUi";

export function UiTab(): JSX.Element {
  return (
    <GuideStack>
      <h3 class="guide-h3">Changer le moteur actif</h3>
      <p>
        Pas de switch dans la ConfigBar. Dialog Configuration → select <strong>Moteur</strong> →
        Enregistrer. Tant que ce n'est pas sauvé, le bot tourne sur l'ancien{" "}
        <code>strategyId</code>.
      </p>
      <GuideTable
        headers={["Étape", "Effet"]}
        rows={[
          [
            "Select Moteur (12 moteurs natifs arb … probability-repricing, ou custom:…)",
            "Filtre les profils ; un custom n'a pas de presets — règles chart dans /strategy-editor",
          ],
          ["Ratio hedge", "Onglet hedge ; hint « ignoré par B1 » si arb ; N/A edge-lead"],
          [
            "pairLockMax",
            "Validé 0,90–0,99 pour arb ; hint « ignoré par barbell / edge-lead »",
          ],
          [
            "Bandes edge-lead",
            "edgeBand*, edgeCheapBand*, edgeOrderUsdc — section Jambe edge ; maxShareEdge aussi dans Risque",
          ],
          [
            "Enregistrer",
            "PATCH data/bot-settings.json → hot-swap createStrategy si strategyId a changé",
          ],
          ["ConfigBar", "Affiche moteur + lock ou ratio — bouton Configurer seulement"],
          [
            "Positions",
            "Colonne Moteur = strategyId stampé au POST (GTC) ou au fill (FOK / SIM)",
          ],
        ]}
        rowTone={["info", "neutral", "neutral", "info", "success", "neutral", "info"]}
      />
      <h3 class="guide-h3">Presets = packs d'un moteur</h3>
      <GuideGrid columns={2}>
        <GuideCard title="coverage-max / conservative">
          <p>
            <code>"strategyId": "arb"</code>. Profils lock conservateur ou agressif.
          </p>
        </GuideCard>
        <GuideCard title="edge-lead.json">
          <p>
            <code>"strategyId": "edge-lead"</code>. Bandes edge/cheap et budgets USDC pré-configurés.
          </p>
        </GuideCard>
        <GuideCard title="reverse.json">
          <p>
            <code>"strategyId": "reverse"</code>. Grilles maker underdog (7-10¢) et hedge favori
            (90-95¢), 6 niveaux max, expo 340 USDC, capital sim 1000 USDC.
          </p>
        </GuideCard>
        <GuideCard title="Éditeur /strategy-editor">
          <p>
            Éditeur chart : zones (bande ou tendance), liens nœuds (1→2 et 1→3, enfant après fill
            du parent buy), sauvegarde <code>chartRules</code>.
            Activation <code>custom:…</code> avec des zones lance{" "}
            <code>ChartRulesStrategy</code> (live et backtest). Sans zone, le squelette graphe
            edge-lead s'exécute. Preset Edge-lead = confirm 5 ticks, cheap après fill, vente à perte.
            Une zone de vente avec « Tous vendre » ferme la position complète de l'achat lié.
            Le replay est une preview de signaux, pas un fill.
          </p>
        </GuideCard>
      </GuideGrid>
      <GuideCallout tone="warning" title="Hot-swap milieu de fenêtre">
        <p>
          Pas de migration des paires ouvertes. Le tick suivant applique la nouvelle politique. Un
          switch barbell → arb peut cancel-lock un cheap déjà hors lock ; vers edge-lead change
          complètement l'ordre d'achat ; vers reverse (dé)pose des grilles maker et cesse les
          verrous/défenses.
        </p>
      </GuideCallout>
    </GuideStack>
  );
}

