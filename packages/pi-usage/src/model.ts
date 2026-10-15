export interface Amount {
  input: number; output: number; cacheRead: number; cacheWrite: number; tokens: number;
  cost: number; unknownCost: number;
}
export const zero = (): Amount => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, unknownCost: 0 });
export function add(target: Amount, value: Amount): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "tokens", "cost", "unknownCost"] as const) target[key] += value[key];
}
export const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const text = (value: unknown): string => typeof value === "string" ? value : "";
const validNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function amount(value: unknown): Amount | undefined {
  const data = object(value);
  if (!data) return undefined;
  const { input, output, cacheRead, cacheWrite, totalTokens } = data;
  if (!validNumber(input) || !validNumber(output) || !validNumber(cacheRead) || !validNumber(cacheWrite)) return undefined;
  const cost = object(data.cost)?.total;
  return { input, output, cacheRead, cacheWrite,
    tokens: validNumber(totalTokens) ? totalTokens : input + output + cacheRead + cacheWrite,
    cost: validNumber(cost) ? cost : 0, unknownCost: validNumber(cost) ? 0 : 1 };
}
export interface ChildUsage { file: string; amount: Amount }
export interface RecordUsage {
  key: string; timestamp: number; provider: string; model: string; calls: number;
  amount: Amount | undefined; children: ChildUsage[]; file: string; session: string; cwd: string;
}
export interface ParsedFile {
  file: string; session: string; cwd: string; parent: string; created: number;
  records: RecordUsage[]; issues: number; complete: boolean;
}
export interface UsageRecord extends Amount {
  key: string; timestamp: number; provider: string; model: string; calls: number; session: string; cwd: string;
}
export interface Snapshot {
  records: UsageRecord[];
  scanned: number; cached: number; issues: number; duplicates: number; reconciled: number; capturedAt: number;
}
export const PERIODS = ["today", "week", "last-week", "30d", "all"] as const;
export type Period = typeof PERIODS[number];
export const PERIOD_LABELS: Record<Period, string> = { today: "Today", week: "This week", "last-week": "Last week", "30d": "Last 30 days", all: "All time" };
export function bounds(period: Period, now: number): [number, number] {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const week = new Date(today); week.setDate(week.getDate() - (week.getDay() + 6) % 7);
  const previous = new Date(week); previous.setDate(previous.getDate() - 7);
  const month = new Date(today); month.setDate(month.getDate() - 29);
  return [period === "today" ? +today : period === "week" ? +week : period === "last-week" ? +previous : period === "30d" ? +month : -Infinity,
    period === "last-week" ? +week : now + 1];
}
export interface Stats extends Amount { calls: number; sessions: Set<string> }
export const emptyStats = (): Stats => ({ ...zero(), calls: 0, sessions: new Set() });
export interface ProviderRow { name: string; stats: Stats; models: { name: string; stats: Stats }[] }
export interface Slice { providers: ProviderRow[]; total: Stats }
export type Sort = "cost" | "tokens" | "calls";
export interface Filters { period: Period; query: string; hidden: Set<string>; cwd: string | null; sort: Sort }
export function aggregate(snapshot: Snapshot, filter: Filters): Slice {
  const [start, end] = bounds(filter.period, snapshot.capturedAt);
  const providers = new Map<string, Map<string, Stats>>();
  const total = emptyStats(); const query = filter.query.trim().toLowerCase();
  for (const row of snapshot.records) {
    if (row.timestamp < start || row.timestamp >= end || filter.hidden.has(row.provider) || filter.cwd !== null && row.cwd !== filter.cwd
      || query && !row.provider.toLowerCase().includes(query) && !row.model.toLowerCase().includes(query)) continue;
    let models = providers.get(row.provider); if (!models) { models = new Map(); providers.set(row.provider, models); }
    let stats = models.get(row.model); if (!stats) { stats = emptyStats(); models.set(row.model, stats); }
    for (const value of [stats, total]) { add(value, row); value.calls += row.calls; value.sessions.add(row.session); }
  }
  const compare = (a: { name: string; stats: Stats }, b: { name: string; stats: Stats }) =>
    b.stats[filter.sort] - a.stats[filter.sort] || a.name.localeCompare(b.name);
  return { total, providers: [...providers].map(([name, models]) => {
    const stats = emptyStats();
    for (const model of models.values()) {
      add(stats, model); stats.calls += model.calls; for (const id of model.sessions) stats.sessions.add(id);
    }
    return { name, stats, models: [...models].map(([name, stats]) => ({ name, stats })).sort(compare) };
  }).sort(compare) };
}
