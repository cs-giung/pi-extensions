import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ZaiUsage } from "./api.js";
type Theme = ExtensionContext["ui"]["theme"];

export function formatZaiStatus(usage: ZaiUsage, theme: Theme): string {
  const color = usage.balance <= 0 ? "error" : usage.balance <= 5 ? "warning" : "success";
  const amount = `${usage.balance < 0 ? "-" : ""}$${Math.abs(usage.balance).toFixed(2)}`;
  return theme.fg("muted", "zai ") + theme.fg(color, amount);
}
export function formatZaiError(theme: Theme): string {
  return theme.fg("muted", "zai ") + theme.fg("error", "error");
}
