import { For } from "solid-js";
import type { JSX } from "solid-js";
import { dismissToast, toasts, type Toast } from "../../stores/toastStore";

function ToastCard(props: { toast: Toast }): JSX.Element {
  return (
    <div
      class={`app-toast app-toast--${props.toast.kind}`}
      role={props.toast.kind === "error" ? "alert" : "status"}
    >
      <p class="app-toast__msg">{props.toast.message}</p>
      <button
        type="button"
        class="app-toast__close"
        aria-label="Fermer la notification"
        onClick={() => dismissToast(props.toast.id)}
      >
        ✕
      </button>
    </div>
  );
}

/** Global in-app toasts (top-right). Mount once at app root. */
export function ToastHost(): JSX.Element {
  return (
    <div class="app-toast-host" aria-live="polite" aria-relevant="additions">
      <For each={toasts()}>{(t) => <ToastCard toast={t} />}</For>
    </div>
  );
}
