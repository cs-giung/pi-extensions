import type {
  ExtensionAPI, ExtensionContext, MarkdownTransformer, SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-message-timestamps-render-hook";
const MESSAGE_TYPES = ["user", "assistant"] as const;

/** Local wall-clock time, with a date so restored history is unambiguous. */
export function formatTimestamp(timestamp: string): string | undefined {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Close an unfinished top-level fenced code block before adding metadata. */
export function appendTimestamp(markdown: string, label: string): string {
  let fence: { character: string; length: number } | undefined;
  for (const line of markdown.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const run = match[1]!;
    const rest = match[2]!;
    if (fence) {
      if (run[0] === fence.character && run.length >= fence.length && !rest.trim()) fence = undefined;
    } else if (run[0] !== "`" || !rest.includes("`")) {
      fence = { character: run[0]!, length: run.length };
    }
  }
  const closing = fence ? `\n${fence.character.repeat(fence.length)}` : "";
  return `${markdown}${closing}\n\n${label}`;
}

interface LiveMessage {
  role: "user" | "assistant";
  startIndex: number;
  completed: boolean;
  entry: SessionEntry | undefined;
}

export default function messageTimestamps(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let tui: TUI | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<LiveMessage>();
  const active = new Map<LiveMessage["role"], LiveMessage>();

  function resolveEntry(live: LiveMessage): SessionEntry | undefined {
    if (live.entry || !live.completed || !context) return live.entry;
    // Pi appends messages in lifecycle order. Remember the append position, not
    // text or message.timestamp: both can repeat, and message_end may replace
    // the finalized object. Other structural/custom entries may intervene.
    const entries = context.sessionManager.getEntries();
    for (let index = live.startIndex; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.type === "message" && entry.message.role === live.role) {
        live.entry = entry;
        break;
      }
    }
    return live.entry;
  }

  function register(live?: LiveMessage): void {
    const transformer: MarkdownTransformer = (markdown, render) => {
      if (render.isStreaming || !context || !markdown.trim()) return markdown;
      if (render.messageType !== "user" && render.messageType !== "assistant") return markdown;
      // Persisted components carry their own metadata. Live components retain
      // the transformer snapshot captured at their message_start.
      const timestamp = render.timestamp ?? (render.messageId ? undefined
        : live?.role === render.messageType ? resolveEntry(live)?.timestamp : undefined);
      const label = timestamp ? formatTimestamp(timestamp) : undefined;
      return label ? appendTimestamp(markdown, context.ui.theme.fg("dim", label)) : markdown;
    };
    pi.registerMarkdownTransformer(transformer, { messageTypes: [...MESSAGE_TYPES] });
  }

  function checkPersistence(): void {
    timer = undefined;
    let changed = false;
    for (const live of pending) {
      if (resolveEntry(live)) {
        pending.delete(live);
        changed = true;
      }
    }
    // A user row may already have been cached before a slow message_end hook
    // finished. Invalidate only after persistence, not on every stream update.
    if (changed && tui) {
      tui.invalidate();
      tui.requestRender();
    }
    if (pending.size > 0) {
      timer = setTimeout(checkPersistence, 25);
      timer.unref();
    }
  }

  register();
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    // A zero-height widget obtains the public TUI render/invalidation handle;
    // it does not replace the footer/editor or add transcript/session entries.
    ctx.ui.setWidget(WIDGET_KEY, (ui) => {
      tui = ui;
      return { render: () => [], invalidate() {} };
    }, { placement: "belowEditor" });
    register();
  });
  pi.on("message_start", (event) => {
    if (!context || (event.message.role !== "user" && event.message.role !== "assistant")) return;
    const live: LiveMessage = {
      role: event.message.role,
      startIndex: context.sessionManager.getEntries().length,
      completed: false,
      entry: undefined,
    };
    active.set(live.role, live);
    register(live);
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "user" && event.message.role !== "assistant") return;
    const live = active.get(event.message.role);
    if (!live) return;
    active.delete(live.role);
    live.completed = true;
    pending.add(live);
    // message_end extensions run before SessionManager.appendMessage(). Yield
    // instead of inventing an approximate completion time or blocking the hook.
    if (!timer) {
      timer = setTimeout(checkPersistence, 0);
      timer.unref();
    }
  });
  pi.on("session_tree", () => register());
  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending.clear();
    active.clear();
    context = undefined;
    tui = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
