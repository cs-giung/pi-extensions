import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { ActivityTimeout, type ActivityTimeoutReason } from "./activity-timeout.js";
import type { ChairConfig, ReviewerConfig } from "./config.js";

export type SessionFailureKind =
  | "cancelled"
  | "configuration"
  | ActivityTimeoutReason
  | "empty-response"
  | "model";

export class SessionExecutionError extends Error {
  constructor(
    readonly kind: SessionFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionExecutionError";
  }
}

type AgentConfig = Pick<ReviewerConfig | ChairConfig, "model" | "thinking" | "systemPrompt" | "tools">;

export interface SessionProgress {
  phase: "thinking" | "answering" | "tool";
  toolName?: string;
}

export interface CouncilSessionManagerOptions {
  cwd: string;
  sessionName: string;
  parentSession?: string | undefined;
  sessionDir?: string | undefined;
}

export function createCouncilSessionManager(options: CouncilSessionManagerOptions): SessionManager {
  const manager = SessionManager.create(
    options.cwd,
    options.sessionDir,
    options.parentSession ? { parentSession: options.parentSession } : undefined,
  );
  manager.appendSessionInfo(options.sessionName);
  return manager;
}

export interface RunConfiguredSessionOptions {
  config: AgentConfig;
  prompt: string;
  cwd: string;
  sessionName: string;
  parentSession?: string | undefined;
  idleTimeoutMs: number;
  maxDurationMs: number;
  modelRuntime: ModelRuntime;
  onProgress?: (progress: SessionProgress) => void;
  signal?: AbortSignal | undefined;
}

export async function runConfiguredSession(options: RunConfiguredSessionOptions): Promise<string> {
  const {
    config,
    prompt,
    cwd,
    sessionName,
    parentSession,
    idleTimeoutMs,
    maxDurationMs,
    modelRuntime,
    onProgress,
    signal,
  } = options;
  throwIfAborted(signal);
  const slash = config.model.indexOf("/");
  if (slash <= 0 || slash === config.model.length - 1) {
    throw new SessionExecutionError(
      "configuration",
      `Model "${config.model}" must use the provider/model-id format`,
    );
  }

  const provider = config.model.slice(0, slash);
  const modelId = config.model.slice(slash + 1);
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) {
    throw new SessionExecutionError("configuration", `Unknown model: ${config.model}`);
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: config.systemPrompt,
    appendSystemPrompt: [],
  });

  let session: AgentSession | undefined;
  let activityTimeout: ActivityTimeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let abortListener: (() => void) | undefined;

  try {
    await resourceLoader.reload();
    throwIfAborted(signal);
    ({ session } = await createAgentSession({
      cwd,
      model,
      modelRuntime,
      thinkingLevel: config.thinking,
      tools: config.tools,
      resourceLoader,
      sessionManager: createCouncilSessionManager({ cwd, sessionName, parentSession }),
    }));
    throwIfAborted(signal);

    let lastProgress = "";
    unsubscribe = session.subscribe((event) => {
      activityTimeout?.touch();
      if (!onProgress) {
        return;
      }

      let progress: SessionProgress | undefined;
      if (event.type === "turn_start" || event.type === "tool_execution_end") {
        progress = { phase: "thinking" };
      } else if (event.type === "message_update") {
        progress = { phase: "answering" };
      } else if (event.type === "tool_execution_start") {
        progress = { phase: "tool", toolName: event.toolName };
      }

      if (progress) {
        const key = `${progress.phase}:${progress.toolName ?? ""}`;
        if (key !== lastProgress) {
          lastProgress = key;
          onProgress(progress);
        }
      }
    });

    const cancellationPromise = signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => {
            reject(new SessionExecutionError("cancelled", "Agent run was cancelled"));
          };
          if (signal.aborted) {
            abortListener();
          } else {
            signal.addEventListener("abort", abortListener, { once: true });
          }
        })
      : undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      activityTimeout = new ActivityTimeout({
        idleTimeoutMs,
        maxDurationMs,
        onTimeout: (reason) => {
          const message =
            reason === "idle-timeout"
              ? `Agent was inactive for ${idleTimeoutMs} ms`
              : `Agent exceeded the maximum duration of ${maxDurationMs} ms`;
          reject(new SessionExecutionError(reason, message));
        },
      });
    });

    const promptPromise = session.prompt(prompt, {
      expandPromptTemplates: false,
      source: "extension",
    });
    await (cancellationPromise
      ? Promise.race([promptPromise, timeoutPromise, cancellationPromise])
      : Promise.race([promptPromise, timeoutPromise]));

    return extractFinalAssistantText(session.state.messages);
  } catch (cause) {
    if (cause instanceof SessionExecutionError) {
      if (
        (cause.kind === "cancelled" ||
          cause.kind === "idle-timeout" ||
          cause.kind === "max-duration") &&
        session
      ) {
        await session.abort().catch(() => undefined);
      }
      throw cause;
    }

    const message = cause instanceof Error ? cause.message : String(cause);
    throw new SessionExecutionError("model", `Agent failed: ${message}`, { cause });
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
    unsubscribe?.();
    activityTimeout?.dispose();
    session?.dispose();
  }
}

export function extractFinalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      const detail = typeof message.errorMessage === "string" ? `: ${message.errorMessage}` : "";
      throw new SessionExecutionError("model", `Model stopped with ${message.stopReason}${detail}`);
    }

    if (!Array.isArray(message.content)) {
      break;
    }

    const text = message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          isRecord(part) && part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("")
      .trim();

    if (text.length > 0) {
      return text;
    }
    break;
  }

  throw new SessionExecutionError("empty-response", "Agent returned an empty response");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionExecutionError("cancelled", "Agent run was cancelled");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
