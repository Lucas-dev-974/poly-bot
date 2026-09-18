/**
 * Browser Web Notifications (Notification API) for bot errors.
 *
 * No service worker needed: notifications fire while the dashboard tab is
 * open (foreground or background — e.g. user is in another tab/another
 * screen), which is the dashboard's actual usage. They do NOT fire after the
 * tab is fully closed: that would require a push server + VAPID keys.
 *
 * The user grants the permission once from the Logs panel ("Activer les
 * notifications") or from the first failed close; the choice is stored in
 * localStorage so the panel button reflects the current state.
 */

const LS_KEY = "bot-notify-enabled";

export type NotifyPref = "granted" | "denied" | "unsupported" | "default";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Current effective preference: permission state + local opt-in flag. */
export function notifyPref(): NotifyPref {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (localStorage.getItem(LS_KEY) !== "1") return "default";
  return Notification.permission as NotifyPref;
}

/** Called on explicit user gesture (button click). Returns the new pref. */
export async function requestNotifyPermission(): Promise<NotifyPref> {
  if (!notificationsSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm === "granted") localStorage.setItem(LS_KEY, "1");
  return perm as NotifyPref;
}

/** User opted out via the panel button. */
export function disableNotify(): void {
  localStorage.removeItem(LS_KEY);
}

/** True when a notification bubble should actually be shown. */
function shouldNotify(): boolean {
  return (
    notificationsSupported() &&
    localStorage.getItem(LS_KEY) === "1" &&
    Notification.permission === "granted"
  );
}

/**
 * Fire an OS notification for a bot error. Silent no-op when the user has
 * not enabled notifications. Fires even when the tab is focused: a close
 * failure is easy to miss between two panels, and the in-app log stays the
 * detailed source of truth.
 */
export function notifyError(title: string, body?: string): void {
  if (!shouldNotify()) return;
  try {
    const n = new Notification(title, {
      body: body?.slice(0, 300),
      tag: "bot-error", // one bubble replaces the previous close error
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* Some browsers (mobile) require a service worker for the constructor —
       ignore rather than crash the caller. */
  }
}