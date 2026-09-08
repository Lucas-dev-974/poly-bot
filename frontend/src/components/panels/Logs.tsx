import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { logs } from "../../stores/logStore";
import { timeStr } from "../../utils/format";

export function Logs(): JSX.Element {
  return (
    <Panel title="Logs" full>
      <div class="logs">
        <Show
          when={logs.length > 0}
          fallback={<EmptyState text="Aucun log pour l'instant." />}
        >
          <For each={logs}>
            {(log) => (
              <div>
                <span class="ts">[{timeStr(log.ts)}]</span>{" "}
                <span class={log.isError ? "err" : "ok"}>{log.message}</span>
                {log.data ? " " + JSON.stringify(log.data) : ""}
              </div>
            )}
          </For>
        </Show>
      </div>
    </Panel>
  );
}
