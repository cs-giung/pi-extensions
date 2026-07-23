import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DeepSeekBalance, DeepSeekUsage } from "./api.js";

type Theme = ExtensionContext["ui"]["theme"];

export function formatDeepSeekStatus(usage: DeepSeekUsage, theme: Theme): string {
  const balance = selectBalance(usage.balances);
  if (!usage.available || !balance) return formatDeepSeekUnavailable(theme);

  const color = balance.total <= 0 ? "error" : balance.total <= 5 ? "warning" : "success";
  return `${theme.fg("muted", "deepseek ")}${theme.fg(color, formatMoney(balance.total, balance.currency))}`;
}

export function formatDeepSeekUnavailable(theme: Theme): string {
  return `${theme.fg("muted", "deepseek ")}${theme.fg("dim", "n/a")}`;
}

export function formatDeepSeekError(theme: Theme): string {
  return `${theme.fg("muted", "deepseek ")}${theme.fg("error", "error")}`;
}

export function selectBalance(balances: DeepSeekBalance[]): DeepSeekBalance | undefined {
  return balances.find((balance) => balance.currency === "USD")
    ?? balances.find((balance) => balance.currency === "CNY")
    ?? balances[0];
}

export function formatMoney(amount: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : currency === "CNY" ? "¥" : `${currency} `;
  const magnitude = Math.abs(amount).toFixed(2);
  return amount < 0 ? `-${symbol}${magnitude}` : `${symbol}${magnitude}`;
}
