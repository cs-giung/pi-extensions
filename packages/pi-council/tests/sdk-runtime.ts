import { createAssistantMessageEventStream, InMemoryCredentialStore,
  type Api, type AssistantMessage, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { usage } from "./fixtures.js";

export function answer(model: Model<Api>, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", model: model.id, provider: model.provider, api: model.api, usage, content, stopReason, timestamp: Date.now() };
}
export async function fakeRuntime(respond: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => Promise<AssistantMessage> | AssistantMessage) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider("fake", { api: "openai-completions", apiKey: "fake-test-key", baseUrl: "https://unused.invalid",
    models: ["main", "reviewer"].map((id) => ({ id, name: id, reasoning: false, input: ["text"] as ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 10000, contextWindow: 200000 })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void Promise.resolve().then(() => respond(model, context, options)).then((message) => {
        if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "pending") {
          const reason = message.stopReason === "aborted" ? "aborted" : "error";
          stream.push({ type: "error", reason, error: { ...message, stopReason: reason } });
        } else stream.push({ type: "done", reason: message.stopReason, message });
      }, (cause) => stream.push({ type: "error", reason: "error", error: { ...answer(model, [], "error"), errorMessage: String(cause) } }));
      return stream;
    },
  });
  await runtime.getAvailable("fake");
  return runtime;
}
