import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexUsage, CodexUsageWindow } from "./api.js";

type Theme = ExtensionContext["ui"]["theme"];

export function formatCodexStatus(usage: CodexUsage, theme: Theme, now = Date.now()): string {
  const windows = [
    usage.primary ? formatWindow(usage.primary, usage.secondary ? "5h" : undefined) : undefined,
    usage.secondary ? formatWindow(usage.secondary, "7d") : undefined,
  ].filter((value): value is string => value !== undefined);

  const remaining = [usage.primary, usage.secondary]
    .filter((window): window is CodexUsageWindow => window !== undefined)
    .map(remainingPercent);
  const lowestRemaining = Math.min(...remaining);
  const color = lowestRemaining <= 10 ? "error" : lowestRemaining <= 25 ? "warning" : "success";
  const resetAt = usage.secondary?.resetAt ?? usage.primary?.resetAt;
  const reset = resetAt === undefined ? "" : theme.fg("dim", ` ↺${formatCountdown(resetAt, now)}`);

  return `${theme.fg("muted", `${usage.label} `)}${theme.fg(color, windows.join(" · "))}${reset}`;
}

export function formatCodexUnavailable(label: "codex" | "spark", theme: Theme): string {
  return `${theme.fg("muted", `${label} `)}${theme.fg("dim", "n/a")}`;
}

export function formatCodexError(label: "codex" | "spark", theme: Theme): string {
  return `${theme.fg("muted", `${label} `)}${theme.fg("error", "error")}`;
}

export function formatCountdown(resetAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((resetAt - now) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function formatWindow(window: CodexUsageWindow, fallbackLabel: string | undefined): string {
  const label = windowLabel(window.windowSeconds) ?? fallbackLabel;
  const value = `${Math.round(remainingPercent(window))}%`;
  return label ? `${label} ${value}` : value;
}

function windowLabel(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (seconds >= 6 * 86_400) return "7d";
  if (seconds >= 4 * 3_600) return "5h";
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 60)}m`;
}

function remainingPercent(window: CodexUsageWindow): number {
  return Math.min(100, Math.max(0, 100 - window.usedPercent));
}
