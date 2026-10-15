import { InMemoryCredentialStore, createAssistantMessageEventStream,
  type AssistantMessage, type Model, type Api, type TranscriptContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { usage } from "./fixtures.js";

export type Respond = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessage | Promise<AssistantMessage>;
export function answer(model: Model<Api>, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content, stopReason, usage, timestamp: Date.now() };
}
export async function fakeRuntime(respond: Respond) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider("fake", { api: "openai-completions", apiKey: "fake-test-key", baseUrl: "https://unused.invalid",
    models: ["main", "thesis", "antithesis"].map((id) => ({ id, name: id, reasoning: false, input: ["text"] as ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 10000 })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void Promise.resolve().then(() => respond(model, context, options)).then((message) => {
        if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "pending") {
          const reason = message.stopReason === "aborted" ? "aborted" : "error";
          stream.push({ type: "error", reason, error: { ...message, stopReason: reason } });
        } else stream.push({ type: "done", reason: message.stopReason, message });
      }, (cause) => {
        const message = { ...answer(model, [], "error"), errorMessage: String(cause) };
        stream.push({ type: "error", reason: "error", error: message });
      });
      return stream;
    },
  });
  await runtime.getAvailable("fake");
  return runtime;
}
