import type { JSX } from "solid-js";

export function GraphToolbar(props: {
  onValidate: () => void;
  onSave: () => void;
  onActivate: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onUndo: () => void;
  canUndo: boolean;
  busy: boolean;
}): JSX.Element {
  return (
    <div class="se-toolbar-row">
      <button type="button" class="btn" disabled={props.busy} onClick={props.onValidate}>
        Valider
      </button>
      <button type="button" class="btn" disabled={props.busy} onClick={props.onSave}>
        Sauver
      </button>
      <button
        type="button"
        class="btn"
        disabled={props.busy}
        title="Les zones chart sont exécutées live et en backtest"
        onClick={props.onActivate}
      >
        Activer
      </button>
      <button
        type="button"
        class="btn"
        disabled={props.busy || !props.canUndo}
        onClick={props.onUndo}
      >
        Annuler
      </button>
      <button type="button" class="btn" disabled={props.busy} onClick={props.onExport}>
        Export
      </button>
      <label class="btn">
        Import
        <input
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) props.onImport(file);
            e.currentTarget.value = "";
          }}
        />
      </label>
    </div>
  );
}
