/**
 * Dialog d'export des snapshots marché (page Données) :
 * table (carnet / ticks), marché + plage, format (ndjson / csv / sqlite) et
 * `market_resolutions` en annexe (ndjson / sqlite seulement). Le download
 * est un GET direct : le navigateur gère la réception du stream.
 */
import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import {
  api,
  snapshotExportUrl,
  type SnapshotExportOptionRow,
} from "../../api/client";
import { fmtCount } from "../../utils/format";
import { toMessage } from "../../utils/display";

const TABLE_OPTIONS: Array<{ id: "book_snapshots" | "market_snapshots"; label: string }> = [
  { id: "book_snapshots", label: "Profondeur de carnet (book_snapshots)" },
  { id: "market_snapshots", label: "Ticks marché (market_snapshots)" },
];

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ExportDialog(props: {
  open: boolean;
  onClose(): void;
  /** Pré-remplir le dialog (optionnel, pour l'icône par ligne). */
  initialTable?: "book_snapshots" | "market_snapshots";
  initialSlug?: string;
  initialFormat?: "ndjson" | "csv" | "sqlite";
}): JSX.Element {
  const [table, setTable] = createSignal<"book_snapshots" | "market_snapshots">(
    props.initialTable ?? "book_snapshots",
  );
  const [markets, setMarkets] = createSignal<SnapshotExportOptionRow[] | null>(null);
  const [optionsError, setOptionsError] = createSignal<string | null>(null);
  const [slug, setSlug] = createSignal(props.initialSlug ?? "");
  const [format, setFormat] = createSignal<"ndjson" | "csv" | "sqlite">(
    props.initialFormat ?? "ndjson",
  );
  const [withRes, setWithRes] = createSignal(true);
  const [fromVal, setFromVal] = createSignal("");
  const [toVal, setToVal] = createSignal("");

  let loadedTable = "";
  createEffect(() => {
    const current = table();
    if (!props.open || loadedTable === current) return;
    loadedTable = current;
    setSlug("");
    setMarkets(null);
    setOptionsError(null);
    api
      .snapshotsExportOptions(current)
      .then((r) => setMarkets(r.markets))
      .catch((e) => setOptionsError(toMessage(e)));
  });

  // L'icône ⭳ par ligne pré-remplit la table : la signal `table` ci-dessus
  // n'est initialisée qu'AU PREMIER MOUNT (avant tout initialTable) — sans
  // cet effet, toutes les ouvertures suivantes resteraient sur la table d'avant.
  createEffect(() => {
    const initial = props.initialTable;
    if (props.open && initial != null) setTable(initial);
  });

  const range = (): { fromMs: number | null; toMs: number | null } => ({
    fromMs: fromVal() ? new Date(fromVal()).getTime() : null,
    toMs: toVal() ? new Date(toVal()).getTime() : null,
  });

  /**
   * Estimation : exacte sans filtre (compteurs du serveur), proportionnelle
   * sur la plage sinon (les lignes par jour ne sont pas connues finement).
   */
  const estimate = (): { rows: number | null; approx: boolean } => {
    const list = markets();
    if (!list) return { rows: null, approx: false };
    const selected = slug() ? list.filter((m) => m.eventSlug === slug()) : list;
    const { fromMs, toMs } = range();
    if (fromMs == null && toMs == null) {
      return { rows: selected.reduce((s, m) => s + m.rowCount, 0), approx: false };
    }
    let total = 0;
    for (const m of selected) {
      const span = Math.max(1, m.lastTs - m.firstTs);
      const lo = fromMs ?? m.firstTs;
      const hi = toMs ?? m.lastTs;
      const overlap = Math.max(0, Math.min(hi, m.lastTs) - Math.max(lo, m.firstTs));
      total += Math.round(m.rowCount * Math.min(1, overlap / span));
    }
    return { rows: total, approx: true };
  };

  const preset = (days: number | null): void => {
    if (days == null) {
      setFromVal("");
      setToVal("");
      return;
    }
    setToVal(toLocalInput(Date.now()));
    setFromVal(toLocalInput(Date.now() - days * 86_400_000));
  };

  const download = (): void => {
    const { fromMs, toMs } = range();
    window.location.assign(
      snapshotExportUrl({
        table: table(),
        slug: slug() || null,
        fromMs,
        toMs,
        format: format(),
        includeResolutions: format() !== "csv" && withRes(),
      }),
    );
    props.onClose();
  };

  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={props.onClose}>
        <div class="modal dat-dialog" onClick={(e) => e.stopPropagation()}>
          <h3>⭳ Exporter les données marché</h3>
          <p class="dat-note">
            Téléchargement direct (GET /api/db/snapshots/export) — le stream part dès le clic.
          </p>
          <div class="dat-form">
            <label class="dat-field">
              <span>Données</span>
              <select class="dat-select" value={table()} onChange={(e) => setTable(e.currentTarget.value as "book_snapshots" | "market_snapshots")}>
                <For each={TABLE_OPTIONS}>
                  {(t) => <option value={t.id}>{t.label}</option>}
                </For>
              </select>
            </label>

            <label class="dat-field">
              <span>Marché (eventSlug)</span>
              <select class="dat-select" value={slug()} onChange={(e) => setSlug(e.currentTarget.value)} disabled={markets() == null}>
                <option value="">Tous les marchés</option>
                <For each={markets() ?? []}>
                  {(m) => <option value={m.eventSlug}>{m.title ?? m.eventSlug}</option>}
                </For>
              </select>
            </label>

            <div class="dat-field">
              <span>Plage (fuseau local)</span>
              <div class="dat-row2">
                <input class="dat-input" type="datetime-local" value={fromVal()} onInput={(e) => setFromVal(e.currentTarget.value)} />
                <span class="dat-note">→</span>
                <input class="dat-input" type="datetime-local" value={toVal()} onInput={(e) => setToVal(e.currentTarget.value)} />
                <button type="button" class="btn dat-preset" onClick={() => preset(null)}>Tout</button>
                <button type="button" class="btn dat-preset" onClick={() => preset(7)}>7 j</button>
                <button type="button" class="btn dat-preset" onClick={() => preset(31)}>31 j</button>
              </div>
            </div>

            <label class="dat-field">
              <span>Format</span>
              <select class="dat-select" value={format()} onChange={(e) => setFormat(e.currentTarget.value as "ndjson" | "csv" | "sqlite")}>
                <option value="ndjson">NDJSON — sans perte, ré-importable (recommandé)</option>
                <option value="csv">CSV — pour analyse (Excel/Python), non recommandé au ré-import</option>
                <option value="sqlite">SQLite — fichier .db filtré (gros volumes)</option>
              </select>
            </label>

            <Show when={format() !== "csv"}>
              <label class="dat-policy">
                <input type="checkbox" checked={withRes()} onChange={(e) => setWithRes(e.currentTarget.checked)} />
                <span>Joindre les résolutions (market_resolutions — utile au backtest sur une autre machine)</span>
              </label>
            </Show>

            <Show when={markets() != null}>
              <div class="dat-est">
                <Show
                  when={estimate().rows != null}
                  fallback={<span class="dat-note">Estimation indisponible.</span>}
                >
              <span>
                {estimate().approx ? "≈" : ""} {fmtCount(estimate().rows)} lignes sélectionnées
              </span>
                </Show>
              </div>
            </Show>

            <Show when={optionsError() != null}>
              <div class="dat-err">{optionsError()}</div>
            </Show>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" onClick={props.onClose}>
              Annuler
            </button>
            <button
              type="button"
              class="dat-primary"
              disabled={markets() == null || optionsError() != null}
              onClick={download}
            >
              ⭳ Télécharger
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}