import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import { addLog } from "../../stores/logStore";
import { fmtUsd } from "../../utils/format";
import type { WalletQuote, WithdrawalRow } from "../../types";

const STORAGE_KEY = "wallet.withdraw.to";
const POLYGONSCAN_BASE = "https://polygonscan.com";

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function decimalsOf(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

export function WalletModal(props: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const [quote, setQuote] = createSignal<WalletQuote | null>(null);
  const [loadingQuote, setLoadingQuote] = createSignal(false);
  const [amount, setAmount] = createSignal("");
  const [to, setTo] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [history, setHistory] = createSignal<WithdrawalRow[]>([]);

  async function refreshQuote(): Promise<void> {
    setLoadingQuote(true);
    try {
      const q = await api.walletWithdrawQuote();
      setQuote(q);
    } catch (e) {
      addLog(
        "Wallet : échec du chargement du solde — " +
          (e instanceof Error ? e.message : String(e)),
        undefined,
        true,
      );
    } finally {
      setLoadingQuote(false);
    }
  }

  async function refreshHistory(): Promise<void> {
    try {
      const r = await api.walletWithdrawals(20);
      setHistory(r.withdrawals);
    } catch {
      /* history is best-effort */
    }
  }

  onMount(() => {
    setTo(localStorage.getItem(STORAGE_KEY) ?? "");
  });

  async function open(): Promise<void> {
    await Promise.all([refreshQuote(), refreshHistory()]);
  }

  // Refresh quote + history each time the dialog opens.
  createEffect(() => {
    if (props.open) void open();
  });

  const amountNum = (): number => {
    const v = Number(amount());
    return Number.isFinite(v) ? v : 0;
  };

  const validationError = (): string | null => {
    const q = quote();
    if (!q?.ready || q.onChainPusd === null) return "Solde indisponible";
    const a = amountNum();
    if (a <= 0) return null; // neutral state (empty field)
    if (amount() && decimalsOf(amount().trim()) > 6) {
      return "6 décimales maximum";
    }
    if (a > q.onChainPusd) return `Montant > solde pUSD (${fmtUsd(q.onChainPusd)})`;
    const addr = to().trim();
    if (!addr) return null; // neutral
    if (!isValidAddress(addr)) return "Adresse invalide";
    if (q.funder && addr.toLowerCase() === q.funder.toLowerCase()) {
      return "La destination doit différer du wallet du bot";
    }
    return null;
  };

  const canSubmit = (): boolean => {
    const q = quote();
    if (!q?.ready) return false;
    if (amountNum() <= 0) return false;
    if (decimalsOf(amount().trim()) > 6) return false;
    if (amountNum() > q.onChainPusd!) return false;
    const addr = to().trim();
    if (!isValidAddress(addr)) return false;
    if (q.funder && addr.toLowerCase() === q.funder.toLowerCase()) return false;
    return true;
  };

  async function submit(): Promise<void> {
    const q = quote();
    if (!q || !canSubmit()) return;
    setSending(true);
    try {
      const data = await api.walletWithdraw({
        amountUsd: amountNum(),
        to: to().trim(),
      });
      if (!data.ok) throw new Error(data.error || "Échec du retrait");
      localStorage.setItem(STORAGE_KEY, to().trim());
      addLog(`Retrait de ${fmtUsd(amountNum())} pUSD confirmé on-chain`, {
        txHash: data.txHash,
        to: to().trim(),
      });
      setAmount("");
      setConfirming(false);
      await Promise.all([refreshQuote(), refreshHistory()]);
    } catch (e) {
      addLog(
        "Erreur de retrait : " + (e instanceof Error ? e.message : String(e)),
        undefined,
        true,
      );
      await Promise.all([refreshQuote(), refreshHistory()]);
    } finally {
      setSending(false);
    }
  }

  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={props.onClose}>
        <div class="modal wallet-modal" onClick={(e) => e.stopPropagation()}>
          <Show
            when={!confirming()}
            fallback={
              <div>
                <h3>Confirmer le retrait</h3>
                <p>
                  Retirer <strong>{fmtUsd(amountNum())} pUSD</strong> du wallet
                  du bot vers{" "}
                  <strong>{shortAddr(to().trim())}</strong> (MetaMask).
                  <br />
                  Transaction relayer gasless — irréversible une fois minée.
                </p>
                <div class="modal-actions">
                  <button
                    class="btn"
                    onClick={() => setConfirming(false)}
                    disabled={sending()}
                  >
                    Retour
                  </button>
                  <button
                    class="reset-btn"
                    onClick={() => void submit()}
                    disabled={sending()}
                  >
                    {sending() ? "Transaction en cours…" : "Confirmer le retrait"}
                  </button>
                </div>
                <Show when={sending()}>
                  <p class="wallet-pending">
                    Signature et dispatch relayer en cours (1-3 min). La
                    fenêtre reste ouverte jusqu'à la confirmation.
                  </p>
                </Show>
              </div>
            }
          >
            <h3>Wallet — Retrait pUSD</h3>
            <Show when={loadingQuote() || !quote()}>
              <p>Chargement du solde…</p>
            </Show>
            <Show when={!loadingQuote() && quote()}>
              {(q) => (
                <div>
                  <p class="wallet-funder">
                    Deposit wallet :{" "}
                    <Show
                      when={q().funder}
                      fallback={"non configuré"}
                    >
                      {(f) => (
                        <a
                          href={`${POLYGONSCAN_BASE}/address/${f()}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortAddr(f())}
                        </a>
                      )}
                    </Show>
                  </p>
                  <Show when={q().ready} fallback={<p class="wallet-error">{q().reason}</p>}>
                    <div class="wallet-balances">
                      <div>
                        <span class="label">Solde pUSD on-chain</span>
                        <span class="value">{fmtUsd(q().onChainPusd ?? 0)}</span>
                      </div>
                      <div>
                        <span class="label">Disponible CLOB</span>
                        <span class="value">
                          {q().clobAvailable === null
                            ? "—"
                            : fmtUsd(q().clobAvailable)}
                        </span>
                      </div>
                    </div>
                    <div class="wallet-form">
                      <label>
                        Montant à retirer (pUSD)
                        <div class="wallet-amount-row">
                          <input
                            type="text"
                            inputmode="decimal"
                            placeholder="0.00"
                            value={amount()}
                            onInput={(e) => setAmount(e.currentTarget.value)}
                          />
                          <button
                            class="btn"
                            onClick={() =>
                              setAmount(String(q().onChainPusd ?? 0))
                            }
                          >
                            MAX
                          </button>
                        </div>
                      </label>
                      <label>
                        Adresse de destination (MetaMask)
                        <input
                          type="text"
                          placeholder="0x…"
                          value={to()}
                          onInput={(e) => setTo(e.currentTarget.value)}
                        />
                      </label>
                      <Show when={validationError()}>
                        {(msg) => <p class="wallet-error">{msg()}</p>}
                      </Show>
                      <Show
                        when={
                          amountNum() > (q().clobAvailable ?? Number.POSITIVE_INFINITY)
                        }
                      >
                        <p class="wallet-warn">
                          ⚠ Montant supérieur au disponible CLOB : les ordres
                          reposés du bot peuvent perdre leur backing.
                        </p>
                      </Show>
                    </div>
                    <div class="modal-actions">
                      <button class="btn" onClick={props.onClose}>
                        Fermer
                      </button>
                      <button
                        class="reset-btn"
                        disabled={!canSubmit()}
                        onClick={() => setConfirming(true)}
                      >
                        Retirer
                      </button>
                    </div>
                  </Show>
                </div>
              )}
            </Show>

            <Show when={history().length > 0}>
              <div class="wallet-history">
                <h4>Historique des retraits</h4>
                <For each={history()}>
                  {(row) => (
                    <div class="wallet-history-row">
                      <span class="wallet-ts">
                        {new Date(row.ts).toLocaleString()}
                      </span>
                      <span>{fmtUsd(row.amount)}</span>
                      <span title={row.to}>{shortAddr(row.to)}</span>
                      <Show
                        when={row.success === 1}
                        fallback={
                          <span class="wallet-fail" title={row.errorMessage ?? ""}>
                            ✗
                          </span>
                        }
                      >
                        <a
                          href={`${POLYGONSCAN_BASE}/tx/${row.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          title={row.txHash ?? ""}
                        >
                          ✓
                        </a>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  );
}
