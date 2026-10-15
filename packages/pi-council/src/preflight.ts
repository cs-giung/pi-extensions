import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigurationError, type CouncilConfig } from "./config.js";

/** Validate every Reviewer before spending tokens. Chair access belongs to the ordinary main session. */
export function checkCouncilModels(config: CouncilConfig, runtime: Pick<ModelRuntime, "getModel" | "getAvailableSnapshot">): void {
  const available = new Set(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
  const errors: string[] = [];
  for (const [index, reviewer] of config.reviewers.entries()) {
    const slash = reviewer.model.indexOf("/");
    const model = runtime.getModel(reviewer.model.slice(0, slash), reviewer.model.slice(slash + 1));
    if (!model) errors.push(`Reviewer ${index + 1}: unknown model ${reviewer.model}`);
    else if (!available.has(reviewer.model)) errors.push(`Reviewer ${index + 1}: model ${reviewer.model} is unavailable; check provider authentication and model access`);
  }
  if (errors.length) throw new ConfigurationError(`Council preflight failed:\n${errors.join("\n")}`);
}
export async function createCouncilRuntime(ctx: ExtensionContext, signal: AbortSignal): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ signal, allowModelNetwork: false });
  for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
    const native = ctx.modelRegistry.getRegisteredNativeProvider(id);
    const config = ctx.modelRegistry.getRegisteredProviderConfig(id);
    if (native) runtime.registerNativeProvider(native);
    else if (config) runtime.registerProvider(id, config);
  }
  await runtime.getAvailable(undefined, { signal }); signal.throwIfAborted();
  return runtime;
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
