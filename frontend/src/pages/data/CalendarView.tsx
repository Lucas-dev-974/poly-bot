/**
 * Onglet « Calendrier » de la page Données — grille mensuelle des jours
 * civils UTC où market_snapshots contient des données (bleu, selon le nombre
 * de marchés distincts) + panneau détail de la journée sélectionnée
 * (marchés distincts, lignes marché/carnet, couverture horaire, fenêtres
 * BTC/ETH par timeframe).
 *
 * Données : GET /api/db/calendar (agrégats, cache TTL backend) et
 * GET /api/db/calendar/day?day=<epoch_days> (fenêtres du jour, à la demande).
 * Scan workers readonly côté backend — aucun gel de la boucle du bot.
 */

import { For, Show, createEffect, createMemo, createSignal, on, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import type { DbCalendarDay, DbCalendarDayDetail, DbCalendarResponse } from "../../api/client";
import { Sim2Card } from "../../components/ui/Sim2Card";
import { fmtCount, fmtCountCompact } from "../../utils/format";
import { toMessage } from "../../utils/display";

const MS_DAY = 86_400_000;

/**
 * Paliers d'intensité bleue des jours : nombre de marchés DISTINCTS du jour
 * (max observé ~758 en Sept. 2026). Au-delà de 400 = jour dense.
 */
const DENSE_MARKETS = 400;
const MEDIUM_MARKETS = 100;

const MOIS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

const ASSETS: Record<string, string> = { btc: "Bitcoin", eth: "Ethereum" };
const ADOT: Record<string, string> = { btc: "#f7931a", eth: "#627eea" };

const monthIdx = (day: number): number => {
  const t = new Date(day * MS_DAY);
  return t.getUTCFullYear() * 12 + t.getUTCMonth();
};

const toYm = (idx: number): { y: number; m: number } => ({
  y: Math.floor(idx / 12),
  m: ((idx % 12) + 12) % 12,
});

/** hh:mm UTC depuis un epoch (ms pour les ts de capture, s pour les fenêtres). */
const hhmm = (v: number, seconds = false): string =>
  new Date(seconds ? v * 1000 : v).toISOString().slice(11, 16);

/** `btc-updown-15m-1793943000` → ["btc", "15m"]. */
function parseSlug(slug: string): [string, string] {
  const i = slug.indexOf("-updown-");
  if (i < 0) return [slug, "?"];
  const asset = slug.slice(0, i);
  const rest = slug.slice(i + 8);
  const j = rest.lastIndexOf("-");
  return [asset, j > 0 ? rest.slice(0, j) : rest];
}

interface Cell {
  day: number;
  num: number;
  inMonth: boolean;
  off: boolean;
  today: boolean;
  tier: 0 | 1 | 2 | 3;
  markets: number | null;
  tip: string;
}

interface AssetGroup {
  asset: string;
  windows: number;
  rows: number;
  tfs: Array<[string, number]>;
  wins: Array<{ slug: string; n: number; ws: number; we: number; tf: string }>;
}

export function CalendarView(props: { reloadToken: () => number }): JSX.Element {
  const [cal, setCal] = createSignal<DbCalendarResponse | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  /** Mois affiché (index y*12+m) — null avant la première donnée. */
  const [curM, setCurM] = createSignal<number | null>(null);
  /** Jour civil sélectionné — défaut : aujourd'hui (UTC). */
  const [selDay, setSelDay] = createSignal(Math.floor(Date.now() / MS_DAY));

  const [detail, setDetail] = createSignal<DbCalendarDayDetail | null>(null);
  const [detailBusy, setDetailBusy] = createSignal(false);
  /** Cache de détail par jour (durée de vie = page) — pas une signal. */
  const detailCache = new Map<number, DbCalendarDayDetail>();
  let requestedDay = -1;

  /* Chargement : à l'ouverture de l'onglet + sur Actualiser (token). Le cycle
     auto de 5 s ne touche PAS au calendrier : le scan worker backend est 
     coûteux et caché 3 min côté serveur. */
  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const r = await api.dbCalendar();
      setCal(r);
      const bounds = monthsOf(r);
      if (bounds) {
        const todayM = monthIdx(Math.floor(Date.now() / MS_DAY));
        // Premier chargement seulement : le mois consulté ne bouge pas ensuite.
        setCurM((prev) => prev ?? Math.min(Math.max(todayM, bounds.loM), bounds.hiM));
      }
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setLoading(false);
    }
  }
  onMount(() => void reload());
  // Tracer UNIQUEMENT le token (jamais `cal`, écrit par le fetch lui-même).
  createEffect(on(props.reloadToken, () => void reload(), { defer: true }));

  /** Carte jour → agrégat, pour les cellules et le détail. */
  const dayIndex = createMemo(() => {
    const d = cal();
    const map = new Map<number, DbCalendarDay>();
    for (const x of d?.days ?? []) map.set(x.day, x);
    return map;
  });

  interface Bounds { loM: number; hiM: number; lo: number; hi: number }
  function monthsOf(d: DbCalendarResponse | null): Bounds | null {
    if (!d || d.days.length === 0 || d.rangeStart == null || d.rangeEnd == null) return null;
    return { loM: monthIdx(d.rangeStart), hiM: monthIdx(d.rangeEnd), lo: d.rangeStart, hi: d.rangeEnd };
  }
  const bounds = createMemo(() => monthsOf(cal()));

  /** Grille du mois courant : cellules construites hors JSX (valeurs pures). */
  const grid = createMemo<{
    label: string;
    cells: Cell[];
  } | null>(() => {
    const cur = curM();
    if (cur == null) return null;
    const { y, m } = toYm(cur);
    const first = Math.floor(Date.UTC(y, m, 1) / MS_DAY);
    const idxLead = (new Date(first * MS_DAY).getUTCDay() + 6) % 7;
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const nCells = Math.ceil((idxLead + dim) / 7) * 7;
    const byDay = dayIndex();
    const today = Math.floor(Date.now() / MS_DAY);
    const cells: Cell[] = [];
    for (let k = 0; k < nCells; k++) {
      const day = first - idxLead + k;
      const inMonth = day >= first && day < first + dim;
      const off = day > today;
      const row = byDay.get(day);
      // Marchés 0 = pas de données : cellule grise, jamais un palier bleu.
      const tier: Cell["tier"] = !row
        ? 0
        : row.markets >= DENSE_MARKETS
          ? 3
          : row.markets >= MEDIUM_MARKETS
            ? 2
            : 1;
      const tip = row
        ? `${MOIS[m]} ${new Date(day * MS_DAY).getUTCDate()} — ${fmtCount(row.markets)} marchés · ${fmtCount(row.mktRows)} lignes marché · ${fmtCount(row.bookRows)} lignes carnet`
        : `${MOIS[m]} ${new Date(day * MS_DAY).getUTCDate()} — aucune donnée dans market_snapshots`;
      cells.push({
        day,
        num: new Date(day * MS_DAY).getUTCDate(),
        inMonth,
        off,
        today: day === today,
        tier,
        markets: row ? row.markets : null,
        tip,
      });
    }
    return { label: `${MOIS[m]} ${y}`, cells };
  });

  /* Déteil de la journée sélectionnée : fetch à la demande, cache par jour.
     L'effet trace selDay ET dayIndex (les deux peuvent évoluer indépendamment :
     données arrivant pendant qu'un jour est déjà sélectionné). */
  createEffect(() => {
    const day = selDay();
    const idx = dayIndex();
    setDetail(null);
    requestedDay = -1;
    if (idx.size === 0 || !idx.has(day)) return; // jour vide : état vide, sans fetch
    const cached = detailCache.get(day);
    if (cached) {
      setDetail(cached);
      return;
    }
    requestedDay = day;
    setDetailBusy(true);
    api
      .dbCalendarDay(day)
      .then((r) => {
        detailCache.set(day, r);
        if (requestedDay === day) setDetail(r);
      })
      .catch((e) => {
        // Échec non bloquant : le détail reste vide, l'agrégat du jour tient lieu.
        if (requestedDay === day) console.warn(`[calendrier] détail du jour ${day} : ${toMessage(e)}`);
      })
      .finally(() => {
        if (requestedDay === day) setDetailBusy(false);
      });
  });

  /** Stat chips du haut — dérivés de l'agrégat seul. */
  const stats = createMemo(() => {
    const d = cal();
    if (!d || d.days.length === 0) return null;
    const span = (d.rangeEnd ?? 0) - (d.rangeStart ?? 0) + 1;
    return {
      recorded: d.days.length,
      span,
      empty: Math.max(0, span - d.days.length),
      windows: d.days.reduce((s, x) => s + x.markets, 0),
      mktRows: d.days.reduce((s, x) => s + x.mktRows, 0),
    };
  });

  /** Vue détail : par asset (fenêtres, lignes, répartition par timeframe). */
  const detailAssets = createMemo<AssetGroup[]>(() => {
    const dd = detail();
    if (!dd) return [];
    const per = new Map<string, { w: number; r: number; tf: Map<string, number>; wins: AssetGroup["wins"] }>();
    for (const w of dd.windows) {
      const [asset, tf] = parseSlug(w.slug);
      let e = per.get(asset);
      if (!e) {
        e = { w: 0, r: 0, tf: new Map(), wins: [] };
        per.set(asset, e);
      }
      e.w++;
      e.r += w.n;
      e.tf.set(tf, (e.tf.get(tf) ?? 0) + 1);
      e.wins.push({ ...w, tf });
    }
    return Array.from(per.keys())
      .sort()
      .map((asset) => {
        const e = per.get(asset)!;
        return {
          asset,
          windows: e.w,
          rows: e.r,
          tfs: Array.from(e.tf.entries()).sort((a, b) => a[0].localeCompare(b[0])),
          wins: e.wins.sort((a, b) => a.ws - b.ws),
        };
      });
  });

  const selRec = () => dayIndex().get(selDay());
  const selDate = createMemo(() => new Date(selDay() * MS_DAY));
  const todayM = () => monthIdx(Math.floor(Date.now() / MS_DAY));

  return (
    <div class="data-cal">
      <Show when={cal()?.persistence === false}>
        <p class="data-muted">Persistance désactivée — aucun snapshot à afficher.</p>
      </Show>

      <Show when={error()}>
        <div class="data-error">{error()}</div>
      </Show>

      <Show when={loading()}>
        <p class="data-muted">
          Scan du calendrier en cours (worker lecture seule) — quelques secondes sur une base volumineuse…
        </p>
      </Show>

      <Show when={stats()}>
        <div class="data-cal-stats">
          <div class="data-stat">
            <span class="l">Jours avec données</span>
            <span class="v mono">
              <b>{fmtCount(stats()!.recorded)}</b>
              <small> / {fmtCount(stats()!.span)} j de plage</small>
            </span>
          </div>
          <div class="data-stat">
            <span class="l">Jours sans données</span>
            <span class="v mono"><b>{fmtCount(stats()!.empty)}</b></span>
          </div>
          <div class="data-stat">
            <span class="l">Fenêtres marché enregistrées</span>
            <span class="v mono"><b>{fmtCountCompact(stats()!.windows)}</b></span>
          </div>
          <div class="data-stat">
            <span class="l">Lignes market_snapshots</span>
            <span class="v mono"><b>{fmtCountCompact(stats()!.mktRows)}</b></span>
          </div>
        </div>
      </Show>

      <div class="data-cal-layout">
        <Sim2Card
          title="Calendrier — Snapshots marché"
          note="market_snapshots · jours UTC — clic sur un jour pour le détail"
          flush
        >
          <div class="data-cal-bar">
            <button
              type="button"
              class="data-cal-navbtn"
              disabled={curM() == null || bounds() == null || curM()! <= bounds()!.loM}
              title="Mois précédent"
              onClick={() => {
                const m = curM();
                if (m != null && m > 0) setCurM(m - 1);
              }}
            >
              ‹
            </button>
            <span class="data-cal-mlabel">{grid()?.label ?? "—"}</span>
            <button
              type="button"
              class="data-cal-navbtn"
              disabled={curM() == null || bounds() == null || curM()! >= bounds()!.hiM}
              title="Mois suivant"
              onClick={() => {
                const m = curM();
                if (m != null) setCurM(m + 1);
              }}
            >
              ›
            </button>
            <button
              type="button"
              class="btn"
              disabled={bounds() == null}
              title="Aller au mois courant"
              onClick={() => {
                const b = bounds();
                if (b) setCurM(Math.min(Math.max(todayM(), b.loM), b.hiM));
              }}
            >
              Aujourd'hui
            </button>
            <span class="data-cal-spacer" />
            <div class="data-cal-legend">
              <span><span class="sw s0" />vide</span>
              <span><span class="sw s1" />&lt; 100 marchés</span>
              <span><span class="sw s2" />100 – 399</span>
              <span><span class="sw s3" />≥ 400</span>
            </div>
          </div>

          <div class="data-cal-dowrow">
            <span class="dow">lun</span>
            <span class="dow">mar</span>
            <span class="dow">mer</span>
            <span class="dow">jeu</span>
            <span class="dow">ven</span>
            <span class="dow">sam</span>
            <span class="dow">dim</span>
          </div>
          <div class="data-cal-weeks">
            <For each={grid()?.cells ?? []}>
              {(c) => (
                <div
                  class="data-cal-cell"
                  classList={{
                    "t0": c.tier === 0,
                    "t1": c.tier === 1,
                    "t2": c.tier === 2,
                    "t3": c.tier === 3,
                    adj: !c.inMonth,
                    off: c.off,
                    today: c.today,
                    sel: selDay() === c.day,
                  }}
                  data-day={c.day}
                  title={c.tip}
                  onClick={() => {
                    if (!c.off) setSelDay(c.day);
                  }}
                >
                  <span class="data-cal-dn">{c.num}</span>
                  <Show when={c.markets != null}>
                    <span class="data-cal-cnt">
                      {fmtCount(c.markets!)}
                      <small> m</small>
                    </span>
                  </Show>
                  <Show when={c.markets == null && !c.off}>
                    <span class="data-cal-cnt" style="color:#3a4150">—</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Sim2Card>

        <Sim2Card title="Journée sélectionnée">
          <div class="data-cal-detail">
            <div class="data-cal-date">
              {JOURS[selDate().getUTCDay()]} {selDate().getUTCDate()} {MOIS[selDate().getUTCMonth()]}{" "}
              {selDate().getUTCFullYear()}{" "}
              <span class="mono utc">UTC</span>
            </div>

            <Show when={!loading() && cal() != null && !selRec()}>
              <div class="data-cal-empty">
                <div class="big">∅</div>
                Aucune donnée dans <span class="mono">market_snapshots</span> pour ce jour civil (UTC).
                {selDay() > (bounds()?.hi ?? Number.POSITIVE_INFINITY)
                  ? " Jour futur — hors plage enregistrée."
                  : " Le bot était à l'arrêt ou le scanner n'a rien capturé."}
              </div>
            </Show>

            <Show when={selRec()}>
              <div class="data-cal-chips">
                <span class="chip">
                  <b>{fmtCount(selRec()!.markets)}</b> marchés distincts
                </span>
                <span class="chip">
                  <b>{fmtCount(selRec()!.mktRows)}</b> lignes marché
                </span>
                <span class="chip">
                  <b>{fmtCount(selRec()!.bookRows)}</b> lignes carnet
                </span>
                <Show when={selRec()!.coverage}>
                  <span class="chip">
                    couverture{" "}
                    <b class="mono">
                      {hhmm(selRec()!.coverage![0])} → {hhmm(selRec()!.coverage![1])}
                    </b>{" "}
                    <span class="utc">UTC</span>
                  </span>
                </Show>
              </div>

              <Show when={detailBusy()}>
                <p class="data-muted">Lecture des fenêtres du jour…</p>
              </Show>

              <For each={detailAssets()}>
                {(a) => (
                  <div class="data-cal-asset">
                    <div class="head">
                      <span class="dot" style={{ background: ADOT[a.asset] ?? "#8b93a3" }} />
                      <span class="an">{ASSETS[a.asset] ?? a.asset}</span>
                      <span class="aws">· {fmtCount(a.windows)} fenêtres</span>
                      <span class="aws right">{fmtCount(a.rows)} lignes</span>
                    </div>
                    <div class="data-cal-tfmap">
                      <For each={a.tfs}>
                        {([tf, n]) => (
                          <span class="tf">
                            {tf} <b>×{fmtCount(n)}</b>
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>

              <div class="data-cal-winlist">
                <For each={detailAssets()}>
                  {(a) => (
                    <For each={a.wins}>
                      {(w) => (
                        <div class="winrow" title={w.slug}>
                          <span class="wt">
                            {hhmm(w.ws, true)}–{w.we != null && w.we > w.ws ? hhmm(w.we, true) : hhmm(w.ws, true)}
                          </span>
                          <span class="wa">{parseSlug(w.slug)[0]}</span>
                          <span class="ws">{w.tf}</span>
                          <span class="wn">{fmtCount(w.n)} snaps</span>
                        </div>
                      )}
                    </For>
                  )}
                </For>
                <Show when={detail() != null && detail()!.windows.length === 0 && !detailBusy()}>
                  <div class="data-cal-empty small">Aucune fenêtre renvoyée pour ce jour.</div>
                </Show>
              </div>
            </Show>
          </div>
        </Sim2Card>
      </div>
    </div>
  );
}
