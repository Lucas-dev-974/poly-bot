import { Show } from "solid-js";
import type { JSX } from "solid-js";

export function ConfirmModal(props: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={props.onCancel}>
        <div class="modal" onClick={(e) => e.stopPropagation()}>
          <h3>{props.title}</h3>
          <p>{props.message}</p>
          <div class="modal-actions">
            <button class="btn" onClick={props.onCancel}>
              Annuler
            </button>
            <button class="reset-btn" onClick={props.onConfirm}>
              {props.confirmLabel ?? "Confirmer"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
