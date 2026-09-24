import type { BotEvent } from "../types";
import { setConfig, setBotEnabled } from "../stores/botStore";
import { clearMarkets, retainMarkets, setReverseToken, upsertMarket } from "../stores/marketStore";
import {
  addOrUpdateOpen,
  addResolved,
  removeOpen,
} from "../stores/positionStore";
import { addOrder, markOrderCancelled, markOrderFilled } from "../stores/orderStore";
import { setSimStats } from "../stores/statsStore";
import {
  resolveSimPosition,
  setSimBalance,
  setSimConfigState,
  upsertSimOpen,
  setSimEngineStats,
} from "../stores/simStore";
import { replacePolyPositions } from "../stores/polyStore";
import { updateRelayerQuota } from "../stores/quotaStore";
import { addLog } from "../stores/logStore";
import { setWsStatus } from "./wsStore";
import { pushError } from "./toastStore";

/**
 * Route chaque événement SSE vers les stores correspondants.
 * Union discriminée sur event.type — exhaustif.
 */
export function dispatchEvent(event: BotEvent): void {
  switch (event.type) {
    case "config":
      setConfig(event.config);
      break;

    case "balance":
      // Géré par App via liveBalance signal
      break;

    case "simulatedBalance":
      // Capital / balance come from live wallet events
      break;

    case "scan":
      if (event.slugs) retainMarkets(event.slugs);
      else if (event.count === 0) clearMarkets();
      break;

    case "watching":
      upsertMarket(event.event, event.books);
      break;

    case "opportunity":
      setReverseToken(event.opportunity.event.slug, event.opportunity.token.tokenId);
      break;

    case "order": {
      const o = event.opportunity;
      // Si un ordre resting est annulé (fenêtre expirée), marquer l'ordre
      // existant au lieu d'en ajouter un nouveau.
      const orderId = (event.result.response as { orderID?: string } | undefined)?.orderID;
      if (event.result.reason === "cancelled") {
        markOrderCancelled(o.token.tokenId, orderId);
      } else {
        addOrder({
          kind: o.kind,
          market: o.event.title,
          slug: o.event.slug,
          tokenId: o.token.tokenId,
          outcome: o.token.outcome,
          side: event.result.side,
          price: o.price,
          fillPrice: event.result.fillPrice,
          size: o.size,
          windowEnd: o.event.windowEnd,
          filled: event.result.filled !== false,
          reason: event.result.reason,
          orderId,
          orderType: event.result.orderType,
        });
      }
      addLog(
        `${event.result.dryRun ? "SIM" : "LIVE"} order ${o.kind} @ ${o.price} x ${o.size} (${o.token.outcome})`,
      );
      break;
    }

    case "openedPosition":
      // Replay can re-emit the same object after it was mutated to won/lost.
      if (event.position.status !== "open") {
        addResolved(event.position);
        removeOpen(event.position.id);
      } else {
        addOrUpdateOpen(event.position);
      }
      // Marquer l'ordre correspondant comme rempli (positions live: id "live:<orderId>")
      if (event.position.id?.startsWith("live:")) {
        markOrderFilled(
          event.position.tokenId,
          event.position.fillPrice,
          event.position.id.slice("live:".length),
        );
      }
      break;

    case "resolvedPosition":
      addResolved(event.position);
      removeOpen(event.position.id);
      break;

    case "simOpenedPosition":
      upsertSimOpen(event.position);
      break;

    case "simResolvedPosition":
      resolveSimPosition(event.position);
      break;

    case "simBalance":
      setSimBalance(event.balance);
      break;

    case "simStats":
      setSimEngineStats(event.stats);
      break;

    case "simConfig":
      setSimConfigState(event.simConfig);
      break;

    case "simulatedStats":
      setSimStats(event.stats);
      break;

    case "stats":
      setSimStats(event.stats);
      break;

    case "resolution":
      addLog(event.message, event.data, true);
      break;

    case "polymarketPositions":
      replacePolyPositions(event.positions);
      break;

    case "relayerQuota":
      updateRelayerQuota(event.quota);
      break;

    case "botControl":
      setBotEnabled(event.enabled);
      break;

    case "error":
      addLog(event.message, undefined, true);
      pushError(event.message, { group: "bot-error", replaceGroup: true });
      break;

    case "log":
          addLog(event.message, event.data, false);
          break;

        case "strategyStatus":
          // Strategy status events are handled via REST polling in WhipsawStatus component
          // No store update needed — the component polls /api/strategy/status directly
          break;

        case "wsStatus":
          setWsStatus(event);
          break;
      }
    }
