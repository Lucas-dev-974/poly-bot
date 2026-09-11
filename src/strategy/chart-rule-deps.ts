/** Minimal rule shape for dependsOn helpers. Shared with the chart editor. */
export type ChartRuleDep = {
  id: string;
  dependsOn?: string[];
};

export function uniqueDependsOn(rule: ChartRuleDep): string[] {
  return [
    ...new Set(
      (rule.dependsOn ?? []).filter((id) => typeof id === "string" && id.length > 0),
    ),
  ];
}

export function chartRulesHaveCycle(rules: ChartRuleDep[]): boolean {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const visiting = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (seen.has(id)) return false;
    visiting.add(id);
    const rule = byId.get(id);
    for (const parent of rule ? uniqueDependsOn(rule) : []) {
      if (visit(parent)) return true;
    }
    visiting.delete(id);
    seen.add(id);
    return false;
  };
  return rules.some((rule) => visit(rule.id));
}

/** Parents before children so 1→2 and 1→3 can fire in the same evaluation. */
export function orderChartRules<T extends ChartRuleDep>(rules: T[]): T[] {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const ordered: T[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const rule = byId.get(id);
    if (!rule) return;
    for (const parent of uniqueDependsOn(rule)) visit(parent);
    ordered.push(rule);
  };
  for (const rule of rules) visit(rule.id);
  return ordered;
}

/** Relie parent → enfant (l'enfant dépend du parent). Null si cycle. */
export function linkChartRules<T extends ChartRuleDep>(
  rules: T[],
  fromId: string,
  toId: string,
): T[] | null {
  if (fromId === toId) return null;
  if (!rules.some((r) => r.id === fromId) || !rules.some((r) => r.id === toId)) {
    return null;
  }
  const next = rules.map((rule) => {
    if (rule.id !== toId) return rule;
    const deps = uniqueDependsOn(rule);
    if (deps.includes(fromId)) return rule;
    return { ...rule, dependsOn: [...deps, fromId] };
  });
  if (chartRulesHaveCycle(next)) return null;
  return next;
}

export function unlinkChartRules<T extends ChartRuleDep>(
  rules: T[],
  fromId: string,
  toId: string,
): T[] {
  return rules.map((rule) => {
    if (rule.id !== toId) return rule;
    const deps = uniqueDependsOn(rule).filter((id) => id !== fromId);
    return { ...rule, dependsOn: deps.length > 0 ? deps : undefined };
  });
}

export function stripDependsOn<T extends ChartRuleDep>(
  rules: T[],
  removedId: string,
): T[] {
  return rules
    .filter((rule) => rule.id !== removedId)
    .map((rule) => {
      const deps = uniqueDependsOn(rule).filter((id) => id !== removedId);
      return { ...rule, dependsOn: deps.length > 0 ? deps : undefined };
    });
}

export function chartRuleLinks(
  rules: ChartRuleDep[],
): Array<{ fromId: string; toId: string }> {
  const out: Array<{ fromId: string; toId: string }> = [];
  for (const rule of rules) {
    for (const fromId of uniqueDependsOn(rule)) {
      out.push({ fromId, toId: rule.id });
    }
  }
  return out;
}
