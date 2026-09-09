import { createSignal } from "solid-js";
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
  CHEAP,
  COMPARE_ROWS,
  EDGE_LEAD_LIFE_EDGES,
  EDGE_LEAD_LIFE_NODES,
  HEDGE_MID,
  HEDGE_TREE,
  NEW_FILES,
  TODOS,
  type EngineId,
  type PhaseId,
  hedgeTarget,
} from "./data";

export function StoryTab(): JSX.Element {
  const [engine, setEngine] = createSignal<EngineId>("arb");
  const [phase, setPhase] = createSignal<PhaseId>("mid");

  const hedgeFilled = () => (phase() === "done" ? hedgeTarget(engine()) : HEDGE_MID);
  const need = () => Math.max(0, hedgeTarget(engine()) - hedgeFilled());
  const keep = CHEAP - hedgeTarget("barbell");
  const arbDefend = () => CHEAP - hedgeFilled();
  const barbellDefend = () => Math.max(0, hedgeTarget("barbell") - hedgeFilled());

  return (
    <GuideStack>
      <p>
        Toutes les 15 minutes, Polymarket pose une question bête : le Bitcoin va-t-il monter ou
        descendre ? Il y a deux billets. Un seul paie 1 $ à la fin. L'autre ne vaut plus rien.
      </p>

      <GuideGrid columns={2}>
        <GuideCard title="Le favori">
          <p>
            Le billet que tout le monde croit gagnant. Cher (souvent 80–90 centimes). Si tu n'as
            que ça, tu gagnes peu si tu as raison, tu perds tout si tu as tort.
          </p>
        </GuideCard>
        <GuideCard title="L'outsider">
          <p>
            Le billet inverse, soldé (souvent 7–20 centimes). Personne n'y croit. S'il gagne, tu
            touches 1 $ sur un truc acheté presque rien.
          </p>
        </GuideCard>
      </GuideGrid>

      <h3 class="guide-h3">Le bot achète d'abord l'outsider, puis le favori</h3>
      <p>
        Jamais l'inverse : acheter le favori tout seul, c'est juste parier. On n'achète le favori
        que quand l'outsider est déjà dans la poche.
      </p>

      <GuideRow>
        <GuidePill active={engine() === "arb"} onClick={() => setEngine("arb")}>
          Arb — le filet
        </GuidePill>
        <GuidePill active={engine() === "barbell"} onClick={() => setEngine("barbell")}>
          Barbell — filet + pari
        </GuidePill>
        <GuidePill active={engine() === "edge-lead"} onClick={() => setEngine("edge-lead")}>
          Edge-lead — favori d'abord
        </GuidePill>
      </GuideRow>
      <GuideRow>
        <GuidePill active={phase() === "mid"} onClick={() => setPhase("mid")}>
          En cours : 10 outsider, 3 favori
        </GuidePill>
        <GuidePill active={phase() === "done"} onClick={() => setPhase("done")}>
          Objectif atteint
        </GuidePill>
      </GuideRow>

      {engine() === "arb" ? (
        <GuideCallout tone="info" title="Arb = un outsider pour un favori">
          <p>
            Tu achètes le même nombre des deux. Les deux prix additionnés restent sous 1 $ (le
            verrou). Un des deux billets paiera 1 $ : tu récupères toujours un peu plus que ce
            que tu as mis. Ennuyeux, et c'est le but.
          </p>
        </GuideCallout>
      ) : engine() === "barbell" ? (
        <GuideCallout tone="warning" title="Barbell = la moitié en filet, la moitié en pari">
          <p>
            Sur 10 outsiders, tu n'achètes que 5 favoris. Les 5 autres restent un pari : si
            l'outsider gagne, tu gagnes gros. Si le favori gagne, tu perds un peu. Ce n'est plus
            un coup sûr.
          </p>
        </GuideCallout>
      ) : (
        <GuideCallout tone="info" title="Edge-lead = le favori d'abord">
          <p>
            On confirme que l'ask du favori monte dans une bande pendant N ticks, on achète
            l'edge en GTC, puis on poste le cheap limit 1:1 à 1 − prix_edge − marge. Si le
            cheap ne remplit jamais, on garde un favori nu (pari directionnel assumé).
          </p>
        </GuideCallout>
      )}

      <GuideCard
        title={
          engine() === "arb"
            ? "Chaque outsider doit avoir son favori"
            : engine() === "barbell"
              ? "Moitié duo, moitié pari (ratio 0,5)"
              : "Edge d'abord, cheap en complément 1:1"
        }
      >
        <TicketStrip engine={engine()} hedgeFilled={hedgeFilled()} />
      </GuideCard>

      <GuideCard title={`Cycle de vie d'une paire — ${engine() === "arb" ? "Arb" : engine() === "barbell" ? "Barbell" : "Edge-lead"}`}>
        <GuideStack gap={10}>
          <p class="guide-muted guide-small">
            Les états colorés engagent du capital ; les flèches sont la condition de passage.
            pairId = slug:windowEnd.
          </p>
          {engine() === "arb" ? (
            <LifecycleDiagram
              nodes={ARB_LIFE_NODES}
              edges={ARB_LIFE_EDGES}
              markerId="life-arrow-arb"
              ariaLabel="Cycle de vie d'une paire arb"
            />
          ) : engine() === "barbell" ? (
            <LifecycleDiagram
              nodes={BARBELL_LIFE_NODES}
              edges={BARBELL_LIFE_EDGES}
              markerId="life-arrow-barbell"
              ariaLabel="Cycle de vie d'une paire barbell"
            />
          ) : (
            <LifecycleDiagram
              nodes={EDGE_LEAD_LIFE_NODES}
              edges={EDGE_LEAD_LIFE_EDGES}
              markerId="life-arrow-edge-lead"
              ariaLabel="Cycle de vie d'une paire edge-lead"
            />
          )}
          {engine() === "arb" ? (
            <p class="guide-muted guide-small">
              Trois sorties après un cheap fillé : filet 1:1 si le lock tient ; directionnel si
              lock cassé ou ask &lt; min ; vente de tout le trou si le favori dépasse le max.
            </p>
          ) : engine() === "barbell" ? (
            <p class="guide-muted guide-small">
              Pas de branche « lock raté ». Le hedge part même au-dessus de 1 $. La défense ne
              vend que la tranche filet manquante ; le leftover « pari » reste jusqu'à la
              résolution.
            </p>
          ) : (
            <p class="guide-muted guide-small">
              L'edge (favori) est acheté d'abord après confirmation de N ticks dans la bande.
              Le cheap est posté juste après le POST edge. Si l'edge sort de la bande, les GTC
              non fillés des deux jambes sont annulés ; un favori nu est accepté si le cheap ne
              remplit jamais.
            </p>
          )}
        </GuideStack>
      </GuideCard>

      <GuideGrid columns={3}>
        <GuideStat value={String(CHEAP)} label="Billets outsider" />
        <GuideStat value={String(hedgeFilled())} label="Billets favori déjà achetés" />
        <GuideStat
          value={String(need())}
          label={engine() === "arb" ? "Encore à jumeler" : "Encore à jumeler (cible 5)"}
        />
      </GuideGrid>

      <h3 class="guide-h3">Si le favori devient trop cher</h3>
      <p>Tu ne peux plus acheter le filet. Il faut décider quoi faire des outsiders tout seuls.</p>
      <GuideGrid columns={2}>
        <GuideCard title="Arb revend tout le trou">
          <p>
            {CHEAP} outsider − {hedgeFilled()} favori = <strong>{arbDefend()}</strong> à vendre.
            Plus de pari : soit le duo est complet, soit tu sors.
          </p>
        </GuideCard>
        <GuideCard title="Barbell ne vend que le filet manquant">
          <p>
            Cible 5 favoris, tu en as {Math.min(hedgeFilled(), 5)} → vend{" "}
            <strong>{barbellDefend()}</strong>, et garde les {keep} « pari ». Si tu vendais les{" "}
            {arbDefend()} restants, tu casserais le pari exprès.
          </p>
        </GuideCard>
      </GuideGrid>

      <h3 class="guide-h3">À la fin des 15 minutes</h3>
      <GuideTable
        headers={["Qui gagne ?", "Arb (10 + 10, lock ~0,98 $)", "Barbell (10 + 5)"]}
        rows={[
          [
            "Le favori (ce que tout le monde pensait)",
            "Les 10 favoris paient 1 $. Petit gain verrouillé.",
            "5 favoris paient 1 $. Les 5 outsiders = 0. Petit moins.",
          ],
          [
            "L'outsider (la surprise)",
            "Les 10 outsiders paient 1 $. Même petit gain verrouillé.",
            "Les 10 outsiders paient 1 $. Gros plus — c'est le pari.",
          ],
        ]}
        rowTone={["neutral", "success"]}
      />
      <p class="guide-muted guide-small">
        Chiffres ronds pour l'idée, pas un P&L live. Min CLOB = 5 parts : 5 outsiders × 0,5 = 2,5
        favoris → trop petit, pas de hedge.
      </p>

      <GuideDetails title="Les 4 étapes du bot (les deux moteurs)" defaultOpen>
        <GuideStack gap={8}>
          <p>1. Attendre un outsider pas cher et un favori dans la bonne zone de prix.</p>
          <p>2. Poser un bid sur l'outsider (ordre qui attend).</p>
          <p>
            3. Quand l'outsider est acheté : acheter le favori — autant (arb) ou la moitié
            (barbell).
          </p>
          <p>
            4. Si le favori sort de la zone : arb revend le trou ; barbell revend seulement le
            filet manquant.
          </p>
        </GuideStack>
      </GuideDetails>

      <GuideDetails title="Détail technique du plan">
        <GuideTable
          headers={["Règle", "Arb", "Barbell"]}
          rows={COMPARE_ROWS}
          rowTone={COMPARE_ROWS.map((_, i) => (i === 1 || i === 4 ? "info" : "neutral"))}
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
            . Le barrel <code>findOpportunities()</code> reste <strong>arb-only</strong> pour les
            tests existants — il ignore <code>strategyId</code>.
          </p>
        </GuideStack>
      </GuideCard>
      <GuideGrid columns={2}>
        <GuideCard
          title="Politique"
          trailing={<span class="guide-tag">stratégie</span>}
        >
          <GuideStack gap={6}>
            <p>Picks cheap / favori, claim de fenêtre</p>
            <p>Tailles et prix (ArbSizing ou BarbellSizing)</p>
            <p>Reprice / cancel cheap resting</p>
            <p>Défense + revalidation hedge live</p>
          </GuideStack>
        </GuideCard>
        <GuideCard title="Exécution" trailing={<span class="guide-tag">bot</span>}>
          <GuideStack gap={6}>
            <p>Scan, tick, pause, READONLY_LIVE</p>
            <p>Place / cancel / poll, confirmation tokens</p>
            <p>Collatéral, exposition, trop près de la clôture</p>
            <p>Tracker, DB, dashboard, redeem</p>
          </GuideStack>
        </GuideCard>
      </GuideGrid>
      <GuideCallout tone="warning" title="Cycle d'imports">
        <p>
          <code>arb-strategy.ts</code> / <code>barbell-strategy.ts</code> /{" "}
          <code>orchestrate.ts</code> n'importent pas <code>src/strategy.ts</code>. Le barrel ne
          fait que réexporter les prédicats et déléguer à <code>new ArbStrategy()</code>. Pas de{" "}
          <code>src/strategy/index.ts</code> (le dossier existe déjà).
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
      <p>
        Live uniquement. <code>executeSimulated</code> return L883 — <strong>ne pas</strong> appeler{" "}
        <code>hedgeAtPostTime</code> en dry-run. Remplace le filtre stale L927 et S2.3 L964–1035,{" "}
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
            "Select Moteur (arb / barbell)",
            "Filtre les profils dans le formulaire ; ne reset pas bandes / GTC / budgets",
          ],
          ["Ratio hedge", "Onglet hedge ; hint « ignoré par B1 » si arb"],
          [
            "pairLockMax",
            "Toujours validé 0,90–0,99 (pour un retour arb) ; hint « ignoré par barbell »",
          ],
          [
            "Enregistrer",
            "PATCH data/bot-settings.json → hot-swap createStrategy si strategyId a changé",
          ],
          ["ConfigBar", "Affiche moteur + lock ou ratio — bouton Configurer seulement"],
          [
            "Positions",
            "Colonne Moteur = strategyId stampé au POST (GTC) ou au fill (FOK / SIM), pas le moteur courant après hot-swap",
          ],
        ]}
        rowTone={["info", "neutral", "neutral", "success", "neutral", "info"]}
      />
      <h3 class="guide-h3">Presets = packs d'un moteur</h3>
      <GuideGrid columns={2}>
        <GuideCard title="coverage-max / conservative">
          <p>
            Top-level obligatoire <code>"strategyId": "arb"</code>. Pas de preset barbell dans ce
            lot → hint « Aucun profil pour ce moteur ».
          </p>
        </GuideCard>
        <GuideCard title="applyPreset (frontend)">
          <p>
            Import JSON statique : merger <code>strategyId: preset.strategyId</code> sinon le clic
            ne pose pas le moteur. Matching aussi filtré par moteur.
          </p>
        </GuideCard>
      </GuideGrid>
      <GuideCallout tone="warning" title="Hot-swap milieu de fenêtre">
        <p>
          Pas de migration des paires ouvertes. Le tick suivant applique la nouvelle politique. Un
          switch barbell → arb peut cancel-lock un cheap déjà hors lock.
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
          ["Presets barbell", "Seulement tagger les deux existants arb"],
          ["Nested { arb, barbell } dans un JSON", "Un preset = un moteur + settings plats"],
          ["Revalidation hedge dry-run", "executeSimulated sort avant S2.3 aujourd'hui"],
          ["Accounting covered 1:1 pour barbell", "Paires ratio < 1 restent partial / directional"],
          ["Changer l'ordre cheap-then-hedge", "Exécution inchangée"],
        ]}
        rowTone={["neutral", "neutral", "neutral", "neutral", "warning", "neutral"]}
      />
      <GuideCallout tone="info" title="Défauts">
        <p>
          JSON sans <code>strategyId</code> → arb. Id inconnu → sanitizePatch throw, live refuse
          de démarrer. <code>parseStrategyId("ARB")</code> → <code>"arb"</code>.
        </p>
      </GuideCallout>
    </GuideStack>
  );
}
