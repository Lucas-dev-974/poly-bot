import { createSignal } from "solid-js";

export type ToastKind = "info" | "error";

export type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
  /** Optional group - replacing a group clears prior toasts with the same key. */
  group?: string;
};

const [toasts, setToasts] = createSignal<Toast[]>([]);
let seq = 0;

export { toasts };

function nextId(): string {
  return `toast-${++seq}`;
}

export function pushToast(
  kind: ToastKind,
  message: string,
  opts?: { group?: string; replaceGroup?: boolean },
): string {
  const id = nextId();
  const next: Toast = { id, kind, message, group: opts?.group };
  setToasts((prev) => {
    const base =
      opts?.replaceGroup && opts.group
        ? prev.filter((t) => t.group !== opts.group)
        : prev;
    return [...base, next].slice(-8);
  });
  return id;
}

export function pushInfo(
  message: string,
  opts?: { group?: string; replaceGroup?: boolean },
): string {
  return pushToast("info", message, opts);
}

export function pushError(
  message: string,
  opts?: { group?: string; replaceGroup?: boolean },
): string {
  return pushToast("error", message, opts);
}

/**
 * Sync a toast group to exactly `messages` (same kind).
 * Keeps existing toast ids when message text is unchanged to avoid remount flicker.
 */
export function setGroupToasts(
  group: string,
  kind: ToastKind,
  messages: string[],
): void {
  setToasts((prev) => {
    const kept = prev.filter((t) => t.group !== group);
    const previous = prev.filter((t) => t.group === group);
    const added: Toast[] = messages.map((message, i) => {
      const reuse = previous[i];
      if (reuse && reuse.message === message && reuse.kind === kind) {
        return reuse;
      }
      return { id: nextId(), kind, message, group };
    });
    return [...kept, ...added].slice(-8);
  });
}

export function dismissToast(id: string): void {
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

export function clearToasts(group?: string): void {
  if (!group) {
    setToasts([]);
    return;
  }
  setToasts((prev) => prev.filter((t) => t.group !== group));
}
