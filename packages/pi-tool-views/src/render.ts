import type { AgentToolResult, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, TruncatedText, stripTerminalSequences, truncateToWidth,
  type Component } from "@earendil-works/pi-tui";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
export type ViewMode = "folded" | "expanded" | "hidden";
export const VIEW_MODES: readonly ViewMode[] = ["folded", "expanded", "hidden"];
export const TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

export function parseMode(value: string): ViewMode | undefined {
  const normalized = value.trim().toLowerCase();
  return VIEW_MODES.find((mode) => mode === normalized);
}

/** Compact headers must never interpret control sequences supplied by tools. */
export function oneLine(value: unknown): string {
  return stripTerminalSequences(typeof value === "string" ? value : "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

function argsObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function callLabel(name: string, value: unknown): string {
  const args = argsObject(value);
  if (name === "bash" || name === "powershell") return `${name === "bash" ? "$" : "PS>"} ${oneLine(args.command) || "[command unavailable]"}`;
  const path = oneLine(args.path ?? args.file_path);
  if (name === "grep") return `grep ${oneLine(args.pattern)}${path ? ` in ${path}` : ""}`;
  if (name === "find") return `find ${oneLine(args.pattern)} in ${path || "."}`;
  return `${name} ${path || (name === "ls" ? "." : "[path unavailable]")}`;
}

function textOutput(result: AgentToolResult): string {
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

export function resultLabel(name: string, result: AgentToolResult, context: Pick<RenderContext, "isError" | "durationMs">): string {
  const text = textOutput(result);
  const details = argsObject(result.details);
  let label: string;
  if (context.isError) {
    const exit = /Command exited with code (\d+)/.exec(text);
    const first = text.split(/\r?\n/).map((line) => oneLine(line)).find(Boolean);
    label = `ERROR ${exit ? `exit ${exit[1]}` : first || "Tool failed"}`;
  } else if (name === "edit" && typeof details.diff === "string") {
    const lines = details.diff.split("\n");
    const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removals = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    label = `OK +${additions} -${removals}`;
  } else if (name === "write") {
    label = "OK Written";
  } else {
    const trimmed = text.replace(/\n$/, "");
    const lines = trimmed ? trimmed.split("\n").length : 0;
    const images = result.content.filter((block) => block.type === "image").length;
    label = `OK ${lines} ${lines === 1 ? "line" : "lines"}${images ? `, ${images} ${images === 1 ? "image" : "images"}` : ""}`;
  }
  if (context.durationMs !== undefined && Number.isFinite(context.durationMs)) {
    label += ` · ${(Math.max(0, context.durationMs) / 1000).toFixed(1)}s`;
  }
  if (argsObject(details.truncation).truncated) label += " · truncated";
  if (typeof details.fullOutputPath === "string") label += " · full output saved";
  return label;
}

export class BoundedContainer extends Container {
  private clipped?: { source: readonly string[]; width: number; lines: readonly string[] };

  override render(width: number): readonly string[] {
    if (width <= 0) return [];
    const source = super.render(width);
    // Pi reuses the source array on unchanged frames. Clip only when needed.
    if (this.clipped?.source !== source || this.clipped.width !== width) {
      this.clipped = { source, width, lines: source.map((line) => truncateToWidth(line, width)) };
    }
    return this.clipped.lines;
  }
}

interface Row {
  display: BoundedContainer;
  nativeCall: Component | undefined;
  nativeResult: Component | undefined;
  result: AgentToolResult | undefined;
}

/** Rendering state is row-local, weakly held, and never written to session data. */
export class ToolViews {
  mode: ViewMode = "folded";
  private rows = new WeakMap<object, Row>();

  clear(): void { this.rows = new WeakMap(); }

  wrap(name: string, base: ToolRenderers): ToolRenderers {
    const rowFor = (context: RenderContext): Row => {
      let row = this.rows.get(context.state);
      if (!row) {
        row = { display: new BoundedContainer(), nativeCall: undefined, nativeResult: undefined, result: undefined };
        this.rows.set(context.state, row);
      }
      return row;
    };
    const expanded = (context: RenderContext) => this.mode === "expanded" || context.expanded;
    const compose = (row: Row, theme: Theme, context: RenderContext): void => {
      row.display.clear();
      if (!context.isPartial && this.mode === "hidden") return;
      const compact = !context.isPartial && this.mode === "folded" && !context.expanded;
      const bg = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
      if (compact) {
        const box = new Box(context.outputPad, 1, (line) => theme.bg(bg, line));
        box.addChild(new TruncatedText(theme.fg("toolTitle", theme.bold(callLabel(name, context.args)))));
        if (row.result) box.addChild(new TruncatedText(theme.fg(context.isError ? "error" : "muted", resultLabel(name, row.result, context))));
        row.display.addChild(box);
      } else {
        // Native self-shell renderers (notably edit) already own their padding
        // and backgrounds. Default renderers get the same single Box as Pi.
        const container = base.renderShell === "self" ? new Container()
          : new Box(context.outputPad, 1, (line) => theme.bg(bg, line));
        if (row.nativeCall) container.addChild(row.nativeCall);
        if (row.nativeResult) container.addChild(row.nativeResult);
        row.display.addChild(container);
      }
    };
    const fallbackCall = (args: unknown, theme: Theme): Component => new Text(theme.fg("toolTitle", callLabel(name, args)), 0, 0);
    const fallbackResult = (result: AgentToolResult, theme: Theme, context: RenderContext): Component => {
      const lines = stripTerminalSequences(textOutput(result)).split("\n");
      return new Text(theme.fg(context.isError ? "error" : "toolOutput", lines.slice(0, expanded(context) ? undefined : 10).join("\n")), 0, 0);
    };
    return {
      // A self shell is necessary to remove even the blank box in hidden mode.
      // Unlike pi-foldable-tools, we restore Pi's themed Box in visible modes.
      renderShell: "self",
      renderCall: (args, theme, context) => {
        const row = rowFor(context);
        const nativeContext = { ...context, expanded: expanded(context), lastComponent: row.nativeCall };
        try {
          row.nativeCall = base.renderCall?.(args, theme, nativeContext) ?? fallbackCall(args, theme);
        } catch {
          try {
            row.nativeCall = base.renderCall?.(args, theme, { ...nativeContext, lastComponent: undefined }) ?? fallbackCall(args, theme);
          } catch {
            row.nativeCall = fallbackCall(args, theme);
          }
        }
        compose(row, theme, context);
        return row.display;
      },
      renderResult: (result, options, theme, context) => {
        const row = rowFor(context);
        row.result = result;
        const nativeOptions = { ...options, expanded: expanded(context) };
        const nativeContext = { ...context, expanded: expanded(context), lastComponent: row.nativeResult };
        // Always finalize native renderers, even when hiding/folding. They own
        // clocks and shared state (e.g. edit diffs); bypassing them leaks state.
        try {
          row.nativeResult = base.renderResult?.(result, nativeOptions, theme, nativeContext) ?? fallbackResult(result, theme, context);
        } catch {
          // Some native renderers change component classes from partial to
          // error output. Retry without a stale lastComponent before falling back.
          try {
            row.nativeResult = base.renderResult?.(result, nativeOptions, theme, { ...nativeContext, lastComponent: undefined })
              ?? fallbackResult(result, theme, context);
          } catch {
            row.nativeResult = fallbackResult(result, theme, context);
          }
        }
        compose(row, theme, context);
        // Both native slots live inside the call slot's one shell. Never pass
        // that wrapper back as lastComponent to either native renderer.
        return new Container();
      },
    };
  }
}
