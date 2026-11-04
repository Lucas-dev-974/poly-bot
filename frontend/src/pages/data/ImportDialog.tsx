/**
 * Dialog d'import de données marché (page Données) — machine à états :
 *
 *   idle → uploading (XHR progressif) → analyzing (dry-run worker)
 *        → summary (résumé + politique merge/replace) → running (poll 1 s)
 *        → done / error
 *
 * Le résumé montre doublons / nouvelles / invalides AVANT l'écriture ; le
 * merge par défaut est idempotent (réimporter le même fichier → 0 inséré).
 * La taille du fichier s'affiche en Go dès la sélection (décision Q3).
 */
import { For, Show, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import {
  api,
  uploadSnapshotImport,
  type SnapshotAnalyzeResult,
  type SnapshotCommitResult,
  type SnapshotImportStatus,
} from "../../api/client";
import { fmtCount } from "../../utils/format";
import { toMessage } from "../../utils/display";

type Phase = "idle" | "uploading" | "analyzing" | "summary" | "running" | "done" | "error";

const TABLE_LABELS: Record<string, string> = {
  book_snapshots: "Profondeur de carnet",
  market_snapshots: "Ticks marché",
  market_resolutions: "Résolutions",
};

export function ImportDialog(props: {
  open: boolean;
  onClose(): void;
  /** Raffraîchit la page (les tables ont potentiellement grossi). */
  onImported(): void;
}): JSX.Element {
  const [file, setFile] = createSignal<File | null>(null);
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [uploadPct, setUploadPct] = createSignal(0);
  const [uploadId, setUploadId] = createSignal<string | null>(null);
  const [summary, setSummary] = createSignal<SnapshotAnalyzeResult | null>(null);
  const [policy, setPolicy] = createSignal<"merge" | "replace">("merge");
  const [result, setResult] = createSignal<SnapshotCommitResult | null>(null);
  const [live, setLive] = createSignal<SnapshotImportStatus | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  let poller: ReturnType<typeof setInterval> | null = null;
  const stopPoll = (): void => {
    if (poller != null) {
      clearInterval(poller);
      poller = null;
    }
  };
  onCleanup(stopPoll);

  const reset = (): void => {
    stopPoll();
    setFile(null);
    setPhase("idle");
    setUploadPct(0);
    setUploadId(null);
    setSummary(null);
    setPolicy("merge");
    setResult(null);
    setLive(null);
    setError(null);
  };

  const pickFile = (f: File | null): void => {
    reset();
    setFile(f);
  };

  const sizeGo = (): string => {
    const f = file();
    return f == null ? "" : `${(f.size / 1024 ** 3).toFixed(2)} Go`;
  };

  const start = async (): Promise<void> => {
    const f = file();
    if (f == null) return;
    setError(null);
    setPhase("uploading");
    try {
      const uploaded = await uploadSnapshotImport(f, (done, total) =>
        setUploadPct(Math.min(100, Math.round((done / Math.max(1, total)) * 100))),
      );
      setUploadId(uploaded.uploadId);
      setPhase("analyzing");
      const s = await api.snapshotsImportAnalyze(uploaded.uploadId);
      setSummary(s);
      setPhase("summary");
    } catch (e) {
      setError(toMessage(e));
      setPhase("error");
    }
  };

  const runImport = async (): Promise<void> => {
    const id = uploadId();
    if (id == null) return;
    setError(null);
    setPhase("running");
    const refresh = async (): Promise<void> => {
      try {
        setLive(await api.snapshotsImportStatus());
      } catch {
        /* le statut peut rater un tick — l'issue (done/error) tranchera */
      }
    };
    poller = setInterval(() => void refresh(), 1000);
    try {
      const r = await api.snapshotsImportCommit(id, policy());
      setResult(r);
      setPhase("done");
      props.onImported();
    } catch (e) {
      setError(toMessage(e));
      setPhase("error");
    } finally {
      stopPoll();
    }
  };

  const abort = async (): Promise<void> => {
    if (phase() === "running") {
      try {
        await api.snapshotsImportCancel();
      } catch {
        /* annulation best-effort */
      }
      props.onImported();
    }
    reset();
  };

  const totalRows = (): number =>
    (summary()?.tables ?? []).reduce((s, t) => s + t.rowsTotal, 0);

  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={() => (phase() === "running" ? undefined : reset())}>
        <div class="modal dat-dialog" onClick={(e) => e.stopPropagation()}>
          <h3>⭱ Importer des données marché</h3>

          <Show when={phase() === "idle"}>
            <p class="dat-note">
              Formats acceptés : NDJSON / CSV / SQLite (exports de cette page ou fichiers compatibles).
              Fusion intelligente : les lignes déjà connues (clé naturelle) sont ignorées — le fichier
              peut être réimporté sans doublon.
            </p>
            <div class="dat-form">
              <label class="dat-field">
                <span>Fichier {sizeGo() ? `— ${sizeGo()}` : ""}</span>
                <input
                  type="file"
                  class="dat-input dat-file"
                  accept=".ndjson,.jsonl,.csv,.db,.sqlite,.sqlite3"
                  onChange={(e) => pickFile(e.currentTarget.files?.[0] ?? null)}
                />
              </label>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn" onClick={reset}>
                Annuler
              </button>
              <button type="button" class="dat-primary" disabled={file() == null} onClick={() => void start()}>
                Analyser le fichier
              </button>
            </div>
          </Show>

          <Show when={phase() === "uploading"}>
            <p class="dat-note">Transfert de {sizeGo()}…</p>
            <div class="dat-bar">
              <i style={{ width: `${uploadPct()}%` }} />
            </div>
            <p class="dat-est">{uploadPct()} %</p>
          </Show>

          <Show when={phase() === "analyzing"}>
            <p class="dat-note">Analyse — croisement avec la base en cours (worker, lecture seule)…</p>
          </Show>

          <Show when={phase() === "summary"}>
            <div class="dat-summary">
              <p class="dat-note">
                {fmtCount(totalRows())} ligne(s) reconnue(s) · format {(summary()?.format ?? "").toUpperCase()}
              </p>
              <For each={(summary()?.tables ?? []).filter((t) => t.rowsTotal > 0)}>
                {(t) => (
                  <div class="dat-tbl">
                    <div class="dat-tbl-name">
                      {TABLE_LABELS[t.name] ?? t.name}
                      <span class="dat-note"> — plage {fmtCount(t.slugCount)} marché(s)</span>
                    </div>
                    <div class="dat-tbl-line">
                      <span class="dat-chip">{fmtCount(t.alreadyPresent)} déjà présentes (ignorées)</span>
                      <span class="dat-chip dat-ok">{fmtCount(t.newRows)} nouvelles</span>
                      <Show when={t.dedupInFile > 0}>
                        <span class="dat-chip">{fmtCount(t.dedupInFile)} doublons dans le fichier</span>
                      </Show>
                      <Show when={t.invalid > 0}>
                        <span class="dat-chip dat-bad">{fmtCount(t.invalid)} invalides</span>
                      </Show>
                    </div>
                    <Show when={t.invalid > 0}>
                      <div class="dat-ex">
                        <For each={t.examples}>{(x) => <div>{x}</div>}</For>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
              <For each={summary()?.warnings ?? []}>
                {(w) => <div class="dat-warn">{w}</div>}
              </For>
              <Show when={totalRows() === 0}>
                <div class="dat-warn">Aucune donnée reconnue dans ce fichier.</div>
              </Show>
              <div class="dat-field">
                <span>Politique d'association avec la base existante</span>
                <label class="dat-policy">
                  <input type="radio" checked={policy() === "merge"} onChange={() => setPolicy("merge")} />
                  <span>Fusionner — ignorer les lignes déjà présentes (idempotent)</span>
                </label>
                <label class="dat-policy">
                  <input type="radio" checked={policy() === "replace"} onChange={() => setPolicy("replace")} />
                  <span>Remplacer la plage — supprime les lignes de la plage × marché avant d'insérer</span>
                </label>
              </div>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn" onClick={() => void abort()}>
                Annuler
              </button>
              <button
                type="button"
                class="dat-primary"
                classList={{ "dat-danger": policy() === "replace" }}
                disabled={totalRows() === 0}
                onClick={() => void runImport()}
              >
                Lancer l'import
              </button>
            </div>
          </Show>

          <Show when={phase() === "running"}>
            <p class="dat-note">Import en cours (workers, batchs transactionnés)…</p>
            <div class="dat-est">
              <Show when={live()?.progress != null}>
                <span>
                  {fmtCount(live()?.progress?.merged ?? 0)} insérées · {fmtCount(live()?.progress?.skipped ?? 0)} ignorées
                </span>
              </Show>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn" onClick={() => void abort()}>
                Annuler l'import
              </button>
            </div>
          </Show>

          <Show when={phase() === "done"}>
            <div class="dat-summary">
              <div class="dat-chips">
                <span class="dat-chip dat-ok">{fmtCount(result()?.inserted ?? 0)} insérées</span>
                <span class="dat-chip">{fmtCount(result()?.skipped ?? 0)} ignorées</span>
                <Show when={(result()?.dedupInFile ?? 0) > 0}>
                  <span class="dat-chip">{fmtCount(result()?.dedupInFile ?? 0)} doublons fichier</span>
                </Show>
                <Show when={(result()?.deleted ?? 0) > 0}>
                  <span class="dat-chip dat-bad">{fmtCount(result()?.deleted ?? 0)} supprimées (replace)</span>
                </Show>
              </div>
              <p class="dat-note">Terminé en {((result()?.elapsedMs ?? 0) / 1000).toFixed(1)} s.</p>
            </div>
            <div class="modal-actions">
              <button type="button" class="dat-primary" onClick={reset}>
                Fermer
              </button>
            </div>
          </Show>

          <Show when={phase() === "error"}>
            <div class="dat-err">{error() ?? "Erreur inconnue."}</div>
            <div class="modal-actions">
              <button type="button" class="btn" onClick={reset}>
                Réessayer
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}