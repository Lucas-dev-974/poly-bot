import type { ConfigFormState } from "../../../utils/configForm";

export type SettingsFormUpdate = <K extends keyof ConfigFormState>(
  key: K,
  value: ConfigFormState[K],
) => void;
