import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { FlowDag, LifecycleDiagram, TicketStrip } from "./Diagrams";
import {
  GuideCallout,
  GuideCard,
  GuideDetails,
  GuideGrid,
  GuidePill,
  GuideRow,
  GuideStack,
  GuideStat,
  GuideTable,
  GuideTodoList,
} from "./GuideUi";
import {
  API_ROWS,
  ARB_LIFE_EDGES,
  ARB_LIFE_NODES,
  BARBELL_LIFE_EDGES,
  BARBELL_LIFE_NODES,
  BOT_STEPS,
  CHEAP,
  COMPARE_ROWS,
  EDGE_LEAD_LIFE_EDGES,
  EDGE_LEAD_LIFE_NODES,
  EDGE_LEAD_PARAM_ROWS,
  ENGINE_META,
  HEDGE_MID,
  HEDGE_TREE,
  NEW_FILES,
  CHART_ZONE_SEMANTICS,
  DIP_LIFE_EDGES,
  DIP_LIFE_NODES,
  REVERSE_LIFE_EDGES,
  REVERSE_LIFE_NODES,
  RESOLUTION_ROWS,
  STRATEGY_COMPARE_ROWS,
  TODOS,
  type EngineId,
  type PhaseId,
  hedgeTarget,
  ANTIFLIP_LIFE_NODES,
  ANTIFLIP_LIFE_EDGES,
  FLIPCONF_LIFE_NODES,
  FLIPCONF_LIFE_EDGES,
  EARLYCONV_LIFE_NODES,
  EARLYCONV_LIFE_EDGES,
  OPENENTRY_LIFE_NODES,
  OPENENTRY_LIFE_EDGES,
  FAVBAND_LIFE_NODES,
  FAVBAND_LIFE_EDGES,
  REPRICING_LIFE_NODES,
  REPRICING_LIFE_EDGES,
} from "./data";

function EngineSelector(props: {
  engine: () => EngineId;
  setEngine: (id: EngineId) => void;
}): JSX.Element {
  return (
    <GuideRow>
      <GuidePill active={props.engine() === "arb"} onClick={() => props.setEngine("arb")}>
        Arb — le filet
      </GuidePill>
      <GuidePill active={props.engine() === "barbell"} onClick={() => props.setEngine("barbell")}>
        Barbell — filet + pari
      </GuidePill>
      <GuidePill active={props.engine() === "edge-lead"} onClick={() => props.setEngine("edge-lead")}>
        Edge-lead — favori d'abord
      </GuidePill>
      <GuidePill active={props.engine() === "reverse"} onClick={() => props.setEngine("reverse")}>
        Reverse — contre la foule
      </GuidePill>
      <GuidePill active={props.engine() === "dip-revert"} onClick={() => props.setEngine("dip-revert")}>
        Dip-revert — favori chuté
      </GuidePill>
      <GuidePill active={props.engine() === "fav-band"} onClick={() => props.setEngine("fav-band")}>
        Fav-band — favori mid-band
      </GuidePill>
      <GuidePill active={props.engine() === "antiflip-revert"} onClick={() => props.setEngine("antiflip-revert")}>
        Antiflip-revert — favori déchu
      </GuidePill>
      <GuidePill active={props.engine() === "flip-confirm"} onClick={() => props.setEngine("flip-confirm")}>
        Flip-confirm — nouveau favori
      </GuidePill>
      <GuidePill active={props.engine() === "early-conviction"} onClick={() => props.setEngine("early-conviction")}>
        Early-conviction — conviction immédiate
      </GuidePill>
      <GuidePill active={props.engine() === "open-entry"} onClick={() => props.setEngine("open-entry")}>
        Open-entry — favori émergent
      </GuidePill>
      <GuidePill active={props.engine() === "probability-repricing"} onClick={() => props.setEngine("probability-repricing")}>
        Prob-repricing — désynchronisation
      </GuidePill>
    </GuideRow>
  );
}

function LifecycleCard(props: { engine: EngineId }): JSX.Element {
  const title = () =>
    props.engine === "arb"
      ? "Arb"
      : props.engine === "barbell"
        ? "Barbell"
        : props.engine === "edge-lead"
          ? "Edge-lead"
          : props.engine === "reverse"
            ? "Reverse"
            : props.engine === "dip-revert"
              ? "Dip-revert"
              : props.engine === "antiflip-revert"
                ? "Antiflip-revert"
                : props.engine === "flip-confirm"
                  ? "Flip-confirm"
                  : props.engine === "open-entry"
                    ? "Open-entry"
                    : props.engine === "fav-band"
                      ? "Fav-band"
                      : props.engine === "probability-repricing"
                        ? "Probability-repricing"
                        : "Early-conviction";

  return (
    <GuideCard title={`Cycle de vie — ${title()}`}>
      <GuideStack gap={10}>
        <p class="guide-muted guide-small">
          Les états colorés engagent du capital ; les flèches sont la condition de passage.
          pairId = slug:windowEnd.
        </p>
        <Show when={props.engine === "arb"}>
          <LifecycleDiagram
            nodes={ARB_LIFE_NODES}
            edges={ARB_LIFE_EDGES}
            markerId="life-arrow-arb"
            ariaLabel="Cycle de vie d'une paire arb"
          />
          <p class="guide-muted guide-small">
            Trois sorties après un cheap fillé : filet 1:1 si le lock tient ; directionnel si
            lock cassé ou ask &lt; min ; vente de tout le trou si le favori dépasse le max.
          </p>
        </Show>
        <Show when={props.engine === "barbell"}>
          <LifecycleDiagram
            nodes={BARBELL_LIFE_NODES}
            edges={BARBELL_LIFE_EDGES}
            markerId="life-arrow-barbell"
            ariaLabel="Cycle de vie d'une paire barbell"
          />
          <p class="guide-muted guide-small">
            Pas de branche « lock raté ». Le hedge part même au-dessus de 1 $. La défense ne vend
            que la tranche filet manquante ; le leftover « pari » reste jusqu'à la résolution.
          </p>
        </Show>
        <Show when={props.engine === "edge-lead"}>
          <LifecycleDiagram
            nodes={EDGE_LEAD_LIFE_NODES}
            edges={EDGE_LEAD_LIFE_EDGES}
            markerId="life-arrow-edge-lead"
            ariaLabel="Cycle de vie d'une paire edge-lead"
          />
          <p class="guide-muted guide-small">
            L'edge est acheté après confirmation de N ticks dans la bande. Le cheap n'est posté
            qu'après fill de l'edge, si l'ask cheap est dans sa bande, avec un budget USDC
            indépendant. Un GTC cheap hors bande cheap est annulé et re-posté si l'ask rentre.
            Si l'edge sort de la bande avant fill, son GTC est annulé.
          </p>
        </Show>
        <Show when={props.engine === "reverse"}>
          <LifecycleDiagram
            nodes={REVERSE_LIFE_NODES}
            edges={REVERSE_LIFE_EDGES}
            markerId="life-arrow-reverse"
            ariaLabel="Cycle de vie d'une paire reverse bot"
          />
          <p class="guide-muted guide-small">
            Deux grilles de limites maker GTC au carnet dès qu'un underdog et un favori sont
            visibles, et seulement si l'ask underdog est encore <code>≥ cheapBuyMin</code>
            (sinon un bid 7-10¢ prendrait tout de suite un token déjà mort). Remplie, la jambe
            sous l'underdog paie ~10× ; celle sous le favori encaisse ~+5%. Chaque niveau est
            dédupliqué par <code>slug:outcome:kind-prix</code>. Cap <code>maxOpenPositionsPerSide</code>
            y compris les niveaux émis dans le même tick. Pas de cancel de bande, pas de
            défense : les grilles tiennent jusqu'à la clôture.
          </p>
        </Show>
        <Show when={props.engine === "dip-revert"}>
          <LifecycleDiagram
            nodes={DIP_LIFE_NODES}
            edges={DIP_LIFE_EDGES}
            markerId="life-arrow-dip"
            ariaLabel="Cycle de vie d'une position dip-revert"
          />
          <p class="guide-muted guide-small">
            Après <code>dipRevertMinElapsedSec</code>, on surveille l'ask du favori. Une chute
            ≥ <code>dipRevertMinDrop</code> sur <code>dipRevertDropLookbackMs</code> (~60 s)
            dans la bande <code>[dipRevertBandMin, dipRevertBandMax]</code> puis un rebond
            (ask &gt; minimum local, spread ≤ <code>dipRevertMaxSpread</code>) déclenche un
            FOK buy au budget <code>dipRevertOrderUsdc</code>. Une seule entrée par fenêtre.
            Pas de hedge, pas de défense : la position est tenue jusqu'à la résolution.
            Aucune stratégie existante (fav-band, edge-lead, arb/barbell) n'achète le favori
            en contrepied d'une chute.
          </p>
        </Show>
        <Show when={props.engine === "antiflip-revert"}>
          <LifecycleDiagram
            nodes={ANTIFLIP_LIFE_NODES}
            edges={ANTIFLIP_LIFE_EDGES}
            markerId="life-arrow-antiflip"
            ariaLabel="Cycle de vie d'une position antiflip-revert"
          />
          <p class="guide-muted guide-small">
            L&apos;identité du favori est suivie tick par tick. Après un flip (le leader
            change) survenant au-delà de <code>antiflipMinElapsedSec</code>, on achète le
            token <strong>déchu</strong> dans les 90 s si son ask est dans la bande (0.35-0.45,
            floor 0.40) et que le nouveau favori reste incertain (0.45-0.65). Une seule entrée
            par fenêtre, pas de hedge. Contrôle causal : sans condition de flip, l&apos;edge
            tombe de +623 $ à +147 $ — c&apos;est la fraîcheur du flip qui porte le signal.
          </p>
        </Show>
        <Show when={props.engine === "flip-confirm"}>
          <LifecycleDiagram
            nodes={FLIPCONF_LIFE_NODES}
            edges={FLIPCONF_LIFE_EDGES}
            markerId="life-arrow-flipconf"
            ariaLabel="Cycle de vie d'une position flip-confirm"
          />
          <p class="guide-muted guide-small">
            Le miroir d&apos;antiflip : ici on achète le <strong>nouveau</strong> favori. Les
            flips précoces sont informationnels, les tardifs sont du bruit : la fenêtre
            d&apos;entrée est verrouillée sur [120, 180] s et ne doit pas être élargie
            (entrées à 180 s+ en perte en backtest).
          </p>
        </Show>
        <Show when={props.engine === "early-conviction"}>
          <LifecycleDiagram
            nodes={EARLYCONV_LIFE_NODES}
            edges={EARLYCONV_LIFE_EDGES}
            markerId="life-arrow-earlyconv"
            ariaLabel="Cycle de vie d'une position early-conviction"
          />
          <p class="guide-muted guide-small">
            Le plus simple : aucun état de flip à tracker. Si le favori cote déjà
            ≥ 0.60 dans les 45 premières secondes, on l&apos;achète immédiatement.
            Ne pas baisser le seuil à 0.55 : le même achat à 0.55 est en perte.
          </p>
        </Show>
        <Show when={props.engine === "open-entry"}>
          <LifecycleDiagram
            nodes={OPENENTRY_LIFE_NODES}
            edges={OPENENTRY_LIFE_EDGES}
            markerId="life-arrow-openentry"
            ariaLabel="Cycle de vie d'une position open-entry"
          />
          <p class="guide-muted guide-small">
            Pas d&apos;inclinaison à t=0 (marché fair) : l&apos;edge est le favori qui
            ÉMERGE. La fair-ness d&apos;ouverture est mémorisée au premier tick
            deux-côtés ; les SL à double échelle sont activables/désactivables
            (openEntrySlEnabled) — hold intégral sinon.
          </p>
        </Show>
        <Show when={props.engine === "fav-band"}>
          <LifecycleDiagram
            nodes={FAVBAND_LIFE_NODES}
            edges={FAVBAND_LIFE_EDGES}
            markerId="life-arrow-favband"
            ariaLabel="Cycle de vie d'une position fav-band"
          />
          <p class="guide-muted guide-small">
            Après <code>favBandMinElapsedSec</code> (200 s), le favori (token au best ask
            le plus haut) est acheté en FOK si son ask est dans la bande
            <code>[favBandAskMin, favBandAskMax]</code> (0.70-0.85). Une seule entrée par
            fenêtre, hold jusqu&apos;à la résolution. Le filtre whipsaw suspend les
            entrées après 3 pertes consécutives (8 fenêtres de pause).
          </p>
        </Show>
        <Show when={props.engine === "probability-repricing"}>
          <LifecycleDiagram
            nodes={REPRICING_LIFE_NODES}
            edges={REPRICING_LIFE_EDGES}
            markerId="life-arrow-repricing"
            ariaLabel="Cycle de vie d'une position probability-repricing"
          />
          <p class="guide-muted guide-small">
            C&apos;est un <strong>path trade</strong>, pas un pari de résolution : le
            moteur détecte une désynchronisation du ask (z-score vs historique 15 s),
            achète en FOK puis <strong>vend toujours au bid</strong> avant la clôture
            (TP, stop, time-stop, tau_force). Inventaire plat obligatoire à τ ≤ 0 —
            sinon <code>forced_settlement</code> est loggé comme échec d&apos;exit.
          </p>
        </Show>
      </GuideStack>
    </GuideCard>
  );
}

function ArbBarbellStory(props: {
  engine: "arb" | "barbell";
  phase: () => PhaseId;
  setPhase: (p: PhaseId) => void;
}): JSX.Element {
  const hedgeFilled = () =>
    props.phase() === "done" ? hedgeTarget(props.engine) : HEDGE_MID;
  const need = () => Math.max(0, hedgeTarget(props.engine) - hedgeFilled());
  const keep = CHEAP - hedgeTarget("barbell");
  const arbDefend = () => CHEAP - hedgeFilled();
  const barbellDefend = () => Math.max(0, hedgeTarget("barbell") - hedgeFilled());

  return (
    <GuideStack>
      <GuideCallout
        tone={ENGINE_META[props.engine].tone}
        title={ENGINE_META[props.engine].label}
      >
        <p>{ENGINE_META[props.engine].subtitle}</p>
        <p class="guide-muted guide-small" style={{ "margin-top": "8px" }}>
          <strong>Ordre :</strong> {ENGINE_META[props.engine].order} ·{" "}
          <strong>Risque :</strong> {ENGINE_META[props.engine].risk}
        </p>
      </GuideCallout>

      <h3 class="guide-h3">Outsider d'abord, favori ensuite</h3>
      <p>
        On ne parie pas sur le favori tout seul. Le bot pose un bid sur l'outsider, attend le
        fill, puis achète le favori —{" "}
        {props.engine === "arb" ? "autant (1:1)" : "au ratio défini (défaut moitié)"}.
      </p>

      <GuideRow>
        <GuidePill active={props.phase() === "mid"} onClick={() => props.setPhase("mid")}>
          En cours : 10 outsider, 3 favori
        </GuidePill>
        <GuidePill active={props.phase() === "done"} onClick={() => props.setPhase("done")}>
          Objectif atteint
        </GuidePill>
      </GuideRow>

      <GuideCard
        title={
          props.engine === "arb"
            ? "Chaque outsider doit avoir son favori"
            : "Moitié duo, moitié pari (ratio 0,5)"
        }
      >
        <TicketStrip engine={props.engine} hedgeFilled={hedgeFilled()} />
      </GuideCard>

      <LifecycleCard engine={props.engine} />

      <GuideGrid columns={3}>
        <GuideStat value={String(CHEAP)} label="Billets outsider" />
        <GuideStat value={String(hedgeFilled())} label="Billets favori déjà achetés" />
        <GuideStat
          value={String(need())}
          label={props.engine === "arb" ? "Encore à jumeler" : "Encore à jumeler (cible 5)"}
        />
      </GuideGrid>

      <h3 class="guide-h3">Si le favori devient trop cher</h3>
      <Show when={props.engine === "arb"}>
        <p>Tu ne peux plus compléter le filet. Le bot revend tout le trou cheap restant.</p>
        <GuideCard title="Arb revend tout le trou">
          <p>
            {CHEAP} outsider − {hedgeFilled()} favori = <strong>{arbDefend()}</strong> à vendre.
            Plus de pari : soit le duo est complet, soit tu sors.
          </p>
        </GuideCard>
      </Show>
      <Show when={props.engine === "barbell"}>
        <p>
          Tu ne peux plus acheter le filet manquant. Seule la tranche « duo » est vendue ; le
          pari leftover reste.
        </p>
        <GuideCard title="Barbell ne vend que le filet manquant">
          <p>
            Cible 5 favoris, tu en as {Math.min(hedgeFilled(), 5)} → vend{" "}
            <strong>{barbellDefend()}</strong>, et garde les {keep} « pari ». Si tu vendais les{" "}
            {arbDefend()} restants, tu casserais le pari exprès.
          </p>
        </GuideCard>
      </Show>

      <h3 class="guide-h3">À la fin des 15 minutes</h3>
      <GuideTable
        headers={["Scénario", "Résultat"]}
        rows={RESOLUTION_ROWS[props.engine]}
        rowTone={RESOLUTION_ROWS[props.engine].map((_, i) => (i === 1 ? "success" : "neutral"))}
      />
      <p class="guide-muted guide-small">
        Chiffres ronds pour l'idée, pas un P&L live. Min CLOB = 5 parts : 5 outsiders × 0,5 = 2,5
        favoris → trop petit, pas de hedge.
      </p>

      <GuideDetails title={`Les 4 étapes — ${props.engine === "arb" ? "Arb" : "Barbell"}`} defaultOpen>
        <GuideStack gap={8}>
          <For each={BOT_STEPS[props.engine]}>
            {(step, i) => <p>{i() + 1}. {step}</p>}
          </For>
        </GuideStack>
      </GuideDetails>

      <Show when={props.engine === "arb"}>
        <GuideDetails title="Détail technique — Arb vs Barbell">
          <GuideTable
            headers={["Règle", "Arb", "Barbell"]}
            rows={COMPARE_ROWS}
            rowTone={COMPARE_ROWS.map((_, i) => (i === 1 || i === 4 ? "info" : "neutral"))}
          />
        </GuideDetails>
      </Show>
    </GuideStack>
  );
}

function EdgeLeadStory(): JSX.Element {
  return (
    <GuideStack>
      <GuideCallout tone={ENGINE_META["edge-lead"].tone} title={ENGINE_META["edge-lead"].label}>
        <p>{ENGINE_META["edge-lead"].subtitle}</p>
        <p class="guide-muted guide-small" style={{ "margin-top": "8px" }}>
          <strong>Ordre :</strong> {ENGINE_META["edge-lead"].order} ·{" "}
          <strong>Risque :</strong> {ENGINE_META["edge-lead"].risk}
        </p>
      </GuideCallout>

      <h3 class="guide-h3">Favori d'abord — cheap seulement après fill</h3>
      <p>
        Contrairement à arb et barbell, edge-lead <strong>commence par le favori</strong>. On
        confirme que son ask monte dans une bande pendant N ticks, on achète l'edge en GTC, on
        attend le fill, puis on poste l'outsider si son ask est dans la bande cheap. Jamais de
        cheap tant que l'edge est seulement resting.
      </p>

      <GuideGrid columns={2}>
        <GuideCard title="Jambe edge (favori)">
          <p>
            Budget <code>edgeOrderUsdc</code> → taille = budget / ask edge, plafonnée par{" "}
            <code>maxShareEdge</code>. Confirmation{" "}
            <code>edgeConfirmSamples</code> ticks dans <code>[edgeBandMin, edgeBandMax]</code>,
            série croissante. GTC au best ask.
          </p>
        </GuideCard>
        <GuideCard title="Jambe cheap (outsider)">
          <p>
            Budget <code>edgeCheapOrderUsdc</code> → taille = budget / ask cheap. Posté{" "}
            <strong>uniquement après fill edge</strong>, si ask ∈{" "}
            <code>[edgeCheapBandMin, edgeCheapBandMax]</code>. Pas de jumelage 1:1 en shares.
          </p>
        </GuideCard>
      </GuideGrid>

      <LifecycleCard engine="edge-lead" />

      <GuideGrid columns={3}>
        <GuideStat value="GTC" label="Type d'ordre edge" />
        <GuideStat value="Après fill" label="Déclencheur cheap" />
        <GuideStat value="USDC" label="Sizing (pas 1:1)" />
      </GuideGrid>

      <h3 class="guide-h3">Gestion des ordres resting</h3>
      <GuideGrid columns={2}>
        <GuideCard title="Edge GTC hors bande">
          <p>
            Si l'ask du favori claimé sort de la bande edge avant fill → cancel + unmark. Les
            fills déjà pris restent.
          </p>
        </GuideCard>
        <GuideCard title="Cheap GTC hors bande cheap">
          <p>
            Cancel + unmark au tick où l'ask sort. Re-post automatique dès que l'ask cheap rentre
            dans la bande (edge déjà fillé).
          </p>
        </GuideCard>
      </GuideGrid>
      <GuideCallout tone="warning" title="Vente de l'edge nu en perte">
        <p>
          Edge-lead n'utilise pas le hedge au POST ni la vente de trou cheap d'arb/barbell. Mais
          si le cheap ne remplit jamais, le favori nu est <strong>vendu</strong> (FOK SELL) quand
          le marché a au moins <code>edgeSellExpensiveAfterMin</code> min et que le best bid est
          en perte <code>edgeSellExpensiveLossPct</code> % sous le prix de fill, de façon continue
          pendant <code>edgeSellExpensiveLossWindowMs</code>.
        </p>
      </GuideCallout>

      <h3 class="guide-h3">À la fin des 15 minutes</h3>
      <GuideTable
        headers={["Scénario", "Résultat"]}
        rows={RESOLUTION_ROWS["edge-lead"]}
        rowTone={["neutral", "success", "warning", "danger"]}
      />

      <GuideDetails title="Les 4 étapes — Edge-lead" defaultOpen>
        <GuideStack gap={8}>
          <For each={BOT_STEPS["edge-lead"]}>
            {(step, i) => <p>{i() + 1}. {step}</p>}
          </For>
        </GuideStack>
      </GuideDetails>

      <GuideDetails title="Paramètres edge-lead">
        <GuideTable
          headers={["Clé", "Rôle"]}
          rows={EDGE_LEAD_PARAM_ROWS}
          rowTone={EDGE_LEAD_PARAM_ROWS.map(() => "neutral")}
        />
      </GuideDetails>
    </GuideStack>
  );
}

function ReverseStory(): JSX.Element {
  return (
    <GuideStack>
      <GuideCallout tone={ENGINE_META["reverse"].tone} title={ENGINE_META["reverse"].label}>
        <p>{ENGINE_META["reverse"].subtitle}</p>
        <p class="guide-muted guide-small" style={{ "margin-top": "8px" }}>
          <strong>Ordre :</strong> {ENGINE_META["reverse"].order} ·{" "}
          <strong>Risque :</strong> {ENGINE_META["reverse"].risk}
        </p>
      </GuideCallout>

      <h3 class="guide-h3">Parie contre la foule, couvert</h3>
      <p>
        En début de fenêtre la foule sur-cote la tendance initiale : l'underdog soldé (2-10¢)
        est traité comme quasi-mort. Le reverse pari que <strong>l'underdog se retourne</strong>{" "}
        avant la clôture — l'inverse du comportement grégaire — et dépose deux grilles de
        limites maker qui restent au carnet.
      </p>

      <GuideGrid columns={2}>
        <GuideCard title="Jambe cheap — sous l'underdog">
          <p>
            Grille de limit BUY maker sur l'outcome dont le <strong>best ask est le plus bas</strong>,
            aux niveaux <code>[cheapBuyMin, cheapBuyMax]</code> (défaut 7-10¢), uniquement si
            l'ask underdog est encore dans ou au-dessus de la bande. Remplissage rare,
            mais <strong>~10×</strong> (0,10$ → 1,00$) si l'underdog gagne.
          </p>
        </GuideCard>
        <GuideCard title="Jambe hedge — sous le favori">
          <p>
            Grille de limit BUY maker sur l'autre outcome, aux niveaux{" "}
            <code>[expensiveBuyMin, expensiveBuyMax]</code> (défaut 90-95¢). Remplissage fréquent,
            petit profit <strong>+5%</strong> — l'amortisseur de variance.
          </p>
        </GuideCard>
      </GuideGrid>

      <LifecycleCard engine="reverse" />

      <GuideGrid columns={3}>
        <GuideStat value="~10×" label="Multiple si l'underdog se retourne" />
        <GuideStat value="+5%" label="Marge hedge si le favori tient" />
        <GuideStat value="Grille" label="Plusieurs niveaux GTC par jambe" />
      </GuideGrid>

      <h3 class="guide-h3">À la fin des 15 minutes</h3>
      <GuideTable
        headers={["Scénario", "Résultat"]}
        rows={RESOLUTION_ROWS["reverse"]}
        rowTone={RESOLUTION_ROWS["reverse"].map((_, i) => (i === 0 ? "success" : "neutral"))}
      />

      <GuideDetails title="Les 5 étapes — Reverse" defaultOpen>
        <GuideStack gap={8}>
          <For each={BOT_STEPS["reverse"]}>
            {(step, i) => <p>{i() + 1}. {step}</p>}
          </For>
        </GuideStack>
      </GuideDetails>

      <GuideCallout tone="warning" title="Ce n'est pas un arbitrage lock">
        <p>
          Une jambe part toujours à 0 $. Sur des centaines de fenêtres, quelques gros revers
          (fort multiple) suffisent à absorber la perte des nombreux petits paris cheap perdants,
          tandis que la grille hedge amortit la variance. Espérance positive <em>via l'asymétrie</em>,
          pas un verrou de profit sous 1,00 $.
        </p>
      </GuideCallout>
    </GuideStack>
  );
}

function DipRevertStory(): JSX.Element {
  return (
    <GuideStack>
      <GuideCallout tone={ENGINE_META["dip-revert"].tone} title={ENGINE_META["dip-revert"].label}>
        <p>{ENGINE_META["dip-revert"].subtitle}</p>
        <p class="guide-muted guide-small" style={{ "margin-top": "8px" }}>
          <strong>Ordre :</strong> {ENGINE_META["dip-revert"].order} ·{" "}
          <strong>Risque :</strong> {ENGINE_META["dip-revert"].risk}
        </p>
      </GuideCallout>

      <h3 class="guide-h3">Le favori sur-pénalisé après une secousse</h3>
      <p>
        Au début de la fenêtre, tout le monde achète le favori ; son ask grimpe. Quand une
        secousse (flux d'ordres, news, gros vendeur) le fait <strong>chuter brutalement</strong>,
        le marché réagit comme si la tendance était cassée — mais les Up/Down 15m reviennent
        souvent à la tendance dominante. Le dip-revert parie que <strong>le favori est temporairement
        sous-évalué</strong> et entre en contrepied.
      </p>

      <GuideGrid columns={2}>
        <GuideCard title="Chute mesurée">
          <p>
            Sur la fenêtre glissante <code>dipRevertDropLookbackMs</code> (~60 s), l'ask du favori
            doit avoir perdu au moins <code>dipRevertMinDrop</code> (défaut 0.03 = 3¢), tout en
            restant dans la bande <code>[dipRevertBandMin, dipRevertBandMax]</code> (défaut
            0.55–0.65) — ni trop « évident », ni déjà effondré.
          </p>
        </GuideCard>
        <GuideCard title="Rebond confirmé">
          <p>
            On n'achète <strong>pas pendant la baisse</strong> : on attend que l'ask repasse au-dessus
            de son minimum local (le prix a cessé de descendre) et que le spread soit
            ≤ <code>dipRevertMaxSpread</code>. Entrée FOK au budget <code>dipRevertOrderUsdc</code>.
          </p>
        </GuideCard>
      </GuideGrid>

      <GuideCallout tone="warning" title="Pas de filet">
        <p>
          Une seule jambe, pas de hedge, pas de défense — la position est tenue jusqu'à la
          résolution. C'est un pari directionnel assumé : sur l'univers audité (&gt; 800 ticks /
          trous ≤ 60 s), le favori chuté + rebond gagne ~64 % du temps (vs ~52 % favori moyen) ;
          le backtest long univers (315 fenêtres) ressort en PnL positif (+62 % sur capital 500 $)
          avec une variance élevée.
        </p>
      </GuideCallout>

      <h3 class="guide-h3">À la fin des 15 minutes</h3>
      <GuideTable
        headers={["Scénario", "Résultat"]}
        rows={RESOLUTION_ROWS["dip-revert"]}
        rowTone={RESOLUTION_ROWS["dip-revert"].map((_, i) => (i === 0 ? "success" : "danger"))}
      />

      <GuideDetails title="Les étapes — Dip-revert" defaultOpen>
        <GuideStack gap={8}>
          <For each={BOT_STEPS["dip-revert"]}>
            {(step, i) => <p>{i() + 1}. {step}</p>}
          </For>
        </GuideStack>
      </GuideDetails>
    </GuideStack>
  );
}

function AntiflipRevertStory(): JSX.Element {
  return (
    <GuideStack>
      <GuideCallout tone={ENGINE_META["antiflip-revert"].tone} title={ENGINE_META["antiflip-revert"].label}>
        <p>{ENGINE_META["antiflip-revert"].subtitle}</p>
        <p class="guide-muted guide-small" style={{ "margin-top": "8px" }}>
          <strong>Ordre :</strong> {ENGINE_META["antiflip-revert"].order} ·{" "}
          <strong>Risque :</strong> {ENGINE_META["antiflip-revert"].risk}
        </p>
      </GuideCallout>

      <h3 class="guide-h3">Le marché sur-réagit au retournement</h3>
      <p>
        Quand le favori d&apos;identité <strong>flippé</strong> (le leader change), les parieurs
        paniquent et replacent l&apos;ancien favori à ~0.43, comme si sa cause était perdue. Mais
        il reste la moitié de la fenêtre pour revenir : il re-gagne ~52 % du temps (backtest
        calibré, 393 fenêtres, +623 $, t-stat 2.74). On achète donc le token déchu dans les 90 s
        suivant le flip, pendant que le marché est encore incertain.
      </p>

      <GuideGrid columns={2}>
        <GuideCard title="Flip frais + incertitude">
          <p>
            Le flip doit dater de &lt; 90 s (<code>antiflipFlipLookbackMs</code>) et le NOUVEAU
            favori coter 0.45-0.65. Au-delà, le marché a digéré le retournement : le contrôle
            causal montre que le même achat avec un flip ancien ne rapporte que +2.70 $.
          </p>
        </GuideCard>
        <GuideCard title="Le déchu dans sa bande">
          <p>
            L&apos;ancien favori doit coter 0.35-0.45 avec un plancher à 0.40 : pas de loterie.
            FOK buy au budget <code>antiflipOrderUsdc</code>, hold jusqu&apos;à la résolution.
          </p>
        </GuideCard>
      </GuideGrid>

      <GuideCallout tone="warning" title="Variance la plus élevée du panel">
        <p>
          WR 52 % avec un gain moyen 17 $ contre une perte moyenne 13 $ : on perd plus souvent
          qu&apos;on gagne, mais le payoff asymétrique rend l&apos;espérance positive. Le sizing
          doit rester prudent — c&apos;est le moteur le plus volatil des trois.
        </p>
      </GuideCallout>

      <h3 class="guide-h3">À la fin des 15 minutes</h3>
      <GuideTable
        headers={["Scénario", "Résultat"]}
        rows={RESOLUTION_ROWS["antiflip-revert"]}
        rowTone={RESOLUTION_ROWS["antiflip-revert"].map((_, i) => (i === 0 ? "success" : "danger"))}
      />

      <GuideDetails title="Les étapes — Antiflip-revert" defaultOpen>
        <GuideStack gap={8}>
          <For each={BOT_STEPS["antiflip-revert"]}>
            {(step, i) => <p>{i() + 1}. {step}</p>}
          </For>
        </GuideStack>
      </GuideDetails>
    </GuideStack>
  );
}

function FlipConfirmStory(): JSX.Element {
  return (
    <GuideStack>
      <GuideCallout tone={ENGINE_META["flip-confirm"].tone} title={ENGINE_META["flip-confirm"].label}>
        <p>{ENGINE_META["flip-confirm"].subtitle}</p>
        <p class="guide-muted guide-small" style={{ "margin-top": "8px" }}>
          <strong>Ordre :</strong> {ENGINE_META["flip-confirm"].order} ·{" "}
          <strong>Risque :</strong> {ENGINE_META["flip-confirm"].risk}
        </p>
      </GuideCallout>

      <h3 class="guide-h3">Le flip précoce est une information</h3>
      <p>
        C&apos;est le miroir d&apos;antiflip, sur un autre moment. Un flip qui arrive{" "}
        <strong>tôt</strong> dans la fenêtre vient d&apos;un vrai déséquilibre (flux, momentum) :
        le marché l&apos;a sous-ajusté. En achetant le nouveau favori à ~0.58 alors qu&apos;il
        gagne 66.5 % du temps, on capte le ré-ajustement (backtest calibré : +389 $, t-stat 2.44,
        drawdown 79 $ le plus bas).
      </p>

      <GuideGrid columns={2}>
        <GuideCard title="La fenêtre d'entrée verrouillée">
          <p>
            L&apos;entrée ne se fait qu&apos;entre 120 et 180 s de fenêtre, sur un flip de moins
            de 90 s. La même logique après 180 s s&apos;effondre (−227 $) puis (−652 $) après
            240 s : les flips tardifs sont du bruit de fin de fenêtre.
          </p>
        </GuideCard>
        <GuideCard title="Robustesse vérifiée">
          <p>
            0 entrée sur 188 déclenchée par une égalité de prix (pas d&apos;artefact de
            tie-break). Avec hystérésis (flip compté seulement si le nouveau mène d&apos;≥ 1
            tick), le PnL monte à +404 $ — le signal est net, pas un fantôme.
          </p>
        </GuideCard>
      </GuideGrid>

      <h3 class="guide-h3">À la fin des 15 minutes</h3>
      <GuideTable
        headers={["Scénario", "Résultat"]}
        rows={RESOLUTION_ROWS["flip-confirm"]}
        rowTone={RESOLUTION_ROWS["flip-confirm"].map((_, i) => (i === 0 ? "success" : "danger"))}
      />

      <GuideDetails title="Les étapes — Flip-confirm" defaultOpen>
        <GuideStack gap={8}>
          <For each={BOT_STEPS["flip-confirm"]}>
            {(step, i) => <p>{i() + 1}. {step}</p>}
          </For>
        </GuideStack>
      </GuideDetails>
    </GuideStack>
  );
}

function EarlyConvictionStory(): JSX.Element {
  return (
    <GuideStack>
      <GuideCallout tone={ENGINE_META["early-conviction"].tone} title={ENGINE_META["early-conviction"].label}>
        <p>{ENGINE_META["early-conviction"].subtitle}</p>
        <p class="guide-muted guide-small" style={{ "margin-top": "8px" }}>
          <strong>Ordre :</strong> {ENGINE_META["early-conviction"].order} ·{" "}
          <strong>Risque :</strong> {ENGINE_META["early-conviction"].risk}
        </p>
      </GuideCallout>

      <h3 class="guide-h3">La vitesse d&apos;établissement est l&apos;information</h3>
      <p>
        Dans une salle d&apos;enchères, si les enchères se stabilisent dès la première minute sur
        un même candidat, c&apos;est que la salle est convaincue. Ici : un favori qui cote déjà
        ≥ 0.60 dans les 45 premières secondes signale un trend unilatéral — le BTC a déjà bougé.
        Le favori gagne 67.6 % du temps à un prix moyen 0.615 (backtest calibré : +330 $,
        drawdown 82 $, le plus bas du panel).
      </p>

      <GuideCallout tone="warning" title="Le plus fragile statistiquement">
        <p>
          t-stat 1.93, sous le seuil conventionnel de 2.0 : signal prometteur mais non
          significatif à lui seul. Et la preuve par le contre-exemple : le même achat avec un
          seuil à 0.55 s&apos;effondre (WR 55 %, −202 $) — l&apos;edge vit dans la zone
          « vite ET fort », pas « vite ».
        </p>
      </GuideCallout>

      <h3 class="guide-h3">À la fin des 15 minutes</h3>
      <GuideTable
        headers={["Scénario", "Résultat"]}
        rows={RESOLUTION_ROWS["early-conviction"]}
        rowTone={RESOLUTION_ROWS["early-conviction"].map((_, i) => (i === 0 ? "success" : "danger"))}
      />

      <GuideDetails title="Les étapes — Early-conviction" defaultOpen>
        <GuideStack gap={8}>
          <For each={BOT_STEPS["early-conviction"]}>
            {(step, i) => <p>{i() + 1}. {step}</p>}
          </For>
        </GuideStack>
      </GuideDetails>
    </GuideStack>
  );
}

function OpenEntryStory(): JSX.Element {
  return (
    <GuideStack>
      <GuideCallout tone={ENGINE_META["open-entry"].tone} title={ENGINE_META["open-entry"].label}>
        <p>{ENGINE_META["open-entry"].subtitle}</p>
        <p class="guide-muted guide-small" style={{ "margin-top": "8px" }}>
          <strong>Ordre :</strong> {ENGINE_META["open-entry"].order} ·{" "}
          <strong>Risque :</strong> {ENGINE_META["open-entry"].risk}
        </p>
      </GuideCallout>

      <h3 class="guide-h3">L'information n'est pas dans la première seconde</h3>
      <p>
        Sondez d'abord : au premier tick (0.5 s en médiane) le carnet est{" "}
        <strong>fair</strong> — la somme des deux asks vaut ≈ 1.01, et l'écart
        up/down n'existe quasiment jamais (aucune occurrence de lean ≥ 0.25).
        L'entrée « dès la première seconde » n'a donc rien à lire. Mais le
        marché <strong>se penche vite</strong> : un favori mène de 0.10 à
        p50 6 secondes. Open-entry achète ce favori <strong>émergent</strong> —
        le premier tick où il mène de 0.15, dans les 300 premières secondes
        d'une ouverture fair (askSum ≤ 1.02 mémorisé au premier tick deux-côtés).
      </p>

      <h3 class="guide-h3">Une échelle de stop, pas un TP</h3>
      <p>
        C'est le seul moteur du guide avec une <strong>sortie défensive à double
        échelle</strong> : tôt dans la fenêtre, la thèse n'est cassée que par un
        changement <strong>structurel</strong> (l'autre billet mène de 0.20 depuis
        20 s <em>et</em> le prix tenu a perdu 0.10) ; tard (après 300 s), un petit
        dégât (0.06) suffit — la thèse a eu le temps de se vérifier. Sinon, hold
        jusqu'à la résolution. Le take-profit pur reste mort ici (4ᵉ audit du
        repo qui le confirme).
      </p>

      <GuideCallout tone="warning" title="Volatilité vs espérance">
        <p>
          Sur le runner officiel (830 fenêtres), le hold intégral bat les SL en
          espérance ($365 vs $330) mais perd en volatilité (WR 63 % vs 35 %,
          pertes par trade lissées par la coupe). Les SL ne se justifient que si
          un PnL régulier compte plus que la moyenne — d'où le switch
          openEntrySlEnabled. Et une asymétrie à retenir : les mêmes SL
          <strong> dégradent</strong> early-conviction ($361 vs $437) — ils ne
          sont validés QUE pour cette entrée émergente, moins chère et plus tôt.
        </p>
      </GuideCallout>

      <h3 class="guide-h3">À la fin des 15 minutes</h3>
      <GuideTable
        headers={["Scénario", "Résultat"]}
        rows={RESOLUTION_ROWS["open-entry"]}
        rowTone={RESOLUTION_ROWS["open-entry"].map((_, i) => (i === 0 ? "success" : i === 1 ? "info" : "danger"))}
      />

      <GuideDetails title="Les étapes — Open-entry" defaultOpen>
        <GuideStack gap={8}>
          <For each={BOT_STEPS["open-entry"]}>
            {(step, i) => <p>{i() + 1}. {step}</p>}
          </For>
        </GuideStack>
      </GuideDetails>
    </GuideStack>
  );
}

function FavBandStory(): JSX.Element {
  return (
    <GuideStack>
      <GuideCallout tone={ENGINE_META["fav-band"].tone} title={ENGINE_META["fav-band"].label}>
        <p>{ENGINE_META["fav-band"].subtitle}</p>
        <p class="guide-muted guide-small" style={{ "margin-top": "8px" }}>
          <strong>Ordre :</strong> {ENGINE_META["fav-band"].order} ·{" "}
          <strong>Risque :</strong> {ENGINE_META["fav-band"].risk}
        </p>
      </GuideCallout>

      <h3 class="guide-h3">Le favori établi reste sous-évalué à mi-fenêtre</h3>
      <p>
        Après ~200 s, un favori qui cote encore 0.70-0.85 est un trend déjà établi mais
        pas encore « évident » : il gagne ~78 % du temps, bien au-dessus de son prix
        d&apos;entrée moyen (~0.77). Les favoris « certitude » (&gt; 0.90) sont eux
        <strong> surcotés</strong> — la bande s&apos;arrête volontairement à 0.85, et le
        moteur n&apos;achète jamais la certitude chère.
      </p>

      <GuideGrid columns={2}>
        <GuideCard title="Bande d'entrée">
          <p>
            Favori = token au <strong>best ask le plus haut</strong>. FOK buy si son ask
            ∈ <code>[favBandAskMin, favBandAskMax]</code> (0.70-0.85) après
            <code>favBandMinElapsedSec</code> (200 s), profondeur ≥ ~80 % de la taille.
            Budget <code>favBandOrderUsdc</code>.
          </p>
        </GuideCard>
        <GuideCard title="Whipsaw — pause après pertes">
          <p>
            3 pertes consécutives suspendent les entrées pendant 8 fenêtres
            (<code>favBandWhipsawEnabled</code>, <code>favBandWhipsawPauseAfterLosses</code>{" "}
            / <code>favBandWhipsawPauseWindows</code>). Reset manuel possible depuis le
            dashboard.
          </p>
        </GuideCard>
      </GuideGrid>

      <LifecycleCard engine="fav-band" />

      <GuideCallout tone="warning" title="Pas de filet">
        <p>
          Une seule jambe, pas de hedge, pas de défense — hold jusqu&apos;à la résolution.
          Les options inverse GTC (<code>favBandInverseEnabled</code>) et exit
          détérioration (<code>favBandExitEnabled</code>) restent <strong>off par
          défaut</strong> : la config recommandée est le hold intégral.
        </p>
      </GuideCallout>

      <h3 class="guide-h3">À la fin des 15 minutes</h3>
      <GuideTable
        headers={["Scénario", "Résultat"]}
        rows={RESOLUTION_ROWS["fav-band"]}
        rowTone={RESOLUTION_ROWS["fav-band"].map((_, i) => (i === 0 ? "success" : "danger"))}
      />

      <GuideDetails title="Les étapes — Fav-band" defaultOpen>
        <GuideStack gap={8}>
          <For each={BOT_STEPS["fav-band"]}>
            {(step, i) => <p>{i() + 1}. {step}</p>}
          </For>
        </GuideStack>
      </GuideDetails>
    </GuideStack>
  );
}

function ProbabilityRepricingStory(): JSX.Element {
  return (
    <GuideStack>
      <GuideCallout tone={ENGINE_META["probability-repricing"].tone} title={ENGINE_META["probability-repricing"].label}>
        <p>{ENGINE_META["probability-repricing"].subtitle}</p>
        <p class="guide-muted guide-small" style={{ "margin-top": "8px" }}>
          <strong>Ordre :</strong> {ENGINE_META["probability-repricing"].order} ·{" "}
          <strong>Risque :</strong> {ENGINE_META["probability-repricing"].risk}
        </p>
      </GuideCallout>

      <h3 class="guide-h3">Un path trade, pas un pari de résolution</h3>
      <p>
        Tous les autres moteurs tiennent jusqu&apos;à la résolution (redeem 1 $ / 0 $).
        Ici non : le moteur détecte une <strong>désynchronisation</strong> du ask — un
        décrochage sous sa propre moyenne récente (z-score ≤ −1.0 sur l&apos;historique
        glissant 15 s, mode C) — achète en FOK, puis <strong>vend toujours au bid</strong>{" "}
        dès qu&apos;un seuil de sortie est touché. L&apos;inventaire doit être plat avant
        la clôture.
      </p>

      <GuideGrid columns={2}>
        <GuideCard title="Entrée — gates stricts">
          <p>
            tau ≥ <code>repricingTauMinSec</code> (90 s), spread ≤ 0.03, p ≤ 0.22,
            edge_est ≥ <code>repricingEdgeMin</code> (0.025), TTL signal 3 s (anti
            re-arm). FOK au ask, plafond <code>repricingNotionalMaxPerMarket</code> (30 $).
          </p>
        </GuideCard>
        <GuideCard title="Sorties — cinq raisons">
          <p>
            TP abs/rel (<code>repricingTargetAbs</code> 0.06), stop (0.08), time-stop
            (120 s), tau_force (25 s avant clôture), spread_exit (0.05). Toujours au
            <strong> bid exécutable</strong>, jamais au mid.
          </p>
        </GuideCard>
      </GuideGrid>

      <LifecycleCard engine="probability-repricing" />

      <GuideCallout tone="warning" title="Seuils placeholders — à calibrer">
        <p>
          Les défauts viennent du papier (§13), pas d&apos;un backtest calibré : ce
          moteur n&apos;a <strong>pas encore de backtest validé</strong> dans
          <code> audits/backtest/</code>. Pas de feed spot/Binance branché — le signal
          utilise l&apos;historique ask CLOB (<code>repricingFeedMaxAgeMs</code> accepté
          mais ignoré). <code>forced_settlement</code> (inventaire ouvert à τ ≤ 0) est
          loggé comme échec d&apos;exit.
        </p>
      </GuideCallout>

      <h3 class="guide-h3">Les quatre sorties possibles</h3>
      <GuideTable
        headers={["Scénario", "Résultat"]}
        rows={RESOLUTION_ROWS["probability-repricing"]}
        rowTone={RESOLUTION_ROWS["probability-repricing"].map((_, i) =>
          i === 0 ? "success" : i === 3 ? "danger" : "warning",
        )}
      />

      <GuideDetails title="Les étapes — Probability-repricing" defaultOpen>
        <GuideStack gap={8}>
          <For each={BOT_STEPS["probability-repricing"]}>
            {(step, i) => <p>{i() + 1}. {step}</p>}
          </For>
        </GuideStack>
      </GuideDetails>
    </GuideStack>
  );
}

export function StoryTab(): JSX.Element {
  const [engine, setEngine] = createSignal<EngineId>("arb");
  const [phase, setPhase] = createSignal<PhaseId>("mid");

  return (
    <GuideStack>
      <p>
        Toutes les 15 minutes, Polymarket pose une question : le Bitcoin va-t-il monter ou
        descendre ?         Deux billets, un seul paie 1 $ à la fin. Onze moteurs jouent ce marché
        différemment — choisis-en un pour voir sa logique.
      </p>

      <GuideGrid columns={2}>
        <GuideCard title="Le favori (edge)">
          <p>
            Le billet que tout le monde croit gagnant. Cher (souvent 80–90 centimes). Seul, c'est
            un pari directionnel.
          </p>
        </GuideCard>
        <GuideCard title="L'outsider (cheap)">
          <p>
            Le billet inverse, soldé (souvent 5–20 centimes). Complète le duo ou sert de pari
            selon le moteur.
          </p>
        </GuideCard>
      </GuideGrid>

      <h3 class="guide-h3">Choisir un moteur</h3>
      <EngineSelector engine={engine} setEngine={setEngine} />

      <Show when={engine() === "arb"}>
        <ArbBarbellStory engine="arb" phase={phase} setPhase={setPhase} />
      </Show>
      <Show when={engine() === "barbell"}>
        <ArbBarbellStory engine="barbell" phase={phase} setPhase={setPhase} />
      </Show>
      <Show when={engine() === "edge-lead"}>
        <EdgeLeadStory />
      </Show>
      <Show when={engine() === "reverse"}>
        <ReverseStory />
      </Show>
      <Show when={engine() === "dip-revert"}>
        <DipRevertStory />
      </Show>
      <Show when={engine() === "antiflip-revert"}>
        <AntiflipRevertStory />
      </Show>
      <Show when={engine() === "flip-confirm"}>
        <FlipConfirmStory />
      </Show>
      <Show when={engine() === "early-conviction"}>
        <EarlyConvictionStory />
      </Show>
      <Show when={engine() === "open-entry"}>
        <OpenEntryStory />
      </Show>
      <Show when={engine() === "fav-band"}>
        <FavBandStory />
      </Show>
      <Show when={engine() === "probability-repricing"}>
        <ProbabilityRepricingStory />
      </Show>

      <GuideDetails title="Comparer les moteurs">
        <GuideTable
          headers={["Règle", "Arb", "Barbell", "Edge-lead", "Reverse", "Dip-revert", "Fav-band", "Antiflip", "Flip-confirm", "Early-conviction", "Open-entry", "Prob-repricing"]}
          rows={STRATEGY_COMPARE_ROWS}
          rowTone={STRATEGY_COMPARE_ROWS.map((_, i) =>
            i === 0 || i === 2 ? "info" : "neutral",
          )}
        />
      </GuideDetails>
    </GuideStack>
  );
}

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
            "Select Moteur (11 moteurs natifs arb … probability-repricing, ou custom:…)",
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
