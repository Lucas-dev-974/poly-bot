import type { JSX } from "solid-js";
import {
  GuideCallout,
  GuideCard,
  GuideGrid,
  GuideStack,
  GuideTable,
} from "../GuideUi";
import { HEDGE_TREE } from "../data";

export function HedgeTab(): JSX.Element {
  return (
    <GuideStack>
      <GuideCallout tone="info" title="Arb & barbell uniquement">
        <p>
          Cet onglet décrit <code>hedgeAtPostTime</code> — le hedge immédiat après fill cheap.
          <strong> Edge-lead</strong> n'utilise pas ce flux : le cheap est posté après fill edge,
          sans revalidation hedge live. <strong>Reverse</strong> non plus : ses deux grilles sont
          déposées par <code>findOpportunities</code>, sans revalidation hedge au POST.
          <strong>Dip-revert</strong> non plus : aucune jambe hedge, hold jusqu'à résolution.
        </p>
      </GuideCallout>
      <p>
        Live uniquement. <code>hedgeAtPostTime</code> tourne <strong>avant</strong> les checks balance/buy
        (defend Policy A possible sans tenter un BUY). Remplace le filtre stale L927 et S2.3 L964–1035,{" "}
        <strong>après</strong> collatéral et exposition.
      </p>
      <h3 class="guide-h3">
        Arbre (un skip « hors bande » trop tôt avale ask &gt; max)
      </h3>
      <GuideTable
        headers={["#", "Condition", "Décision"]}
        rows={HEDGE_TREE}
        rowTone={["warning", "danger", "neutral", "warning", "success"]}
      />
      <GuideGrid columns={3}>
        <GuideCard title="defend">
          <p>
            <code>defendPair</code> vend <code>defendShares</code> (plus de fail-safe isPairCovered
            1:1). Puis cancel GTC hedge, toujours.
          </p>
        </GuideCard>
        <GuideCard title="skip">
          <p>Return sans POST. Cheap tenu directionnel ou déjà couvert.</p>
        </GuideCard>
        <GuideCard title="post">
          <p>
            Maj <code>opportunity.price</code> + <code>estimatedCost</code>, puis FOK/GTC. ask ===
            max reste un POST (bande inclusive).
          </p>
        </GuideCard>
      </GuideGrid>
      <GuideCallout tone="neutral" title="Étape 4 absente en barbell">
        <p>
          Un cheap + hedge ≥ 1,00 $ est accepté. Variance plus élevée — ce n'est pas un lock de
          profit.
        </p>
      </GuideCallout>
    </GuideStack>
  );
}

