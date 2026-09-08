import { createSignal } from "solid-js";
import type { SimulatedStats } from "../types";

export const [simStats, setSimStats] = createSignal<SimulatedStats | null>(null);
