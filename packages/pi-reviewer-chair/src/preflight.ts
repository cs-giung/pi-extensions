import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ConfigurationError, type ReviewerChairConfig } from "./config.js";

/** Validate every configured model before spending tokens on any reviewer. */
export function checkCouncilModels(
  config: ReviewerChairConfig,
  runtime: Pick<ModelRuntime, "getModel" | "getAvailableSnapshot">,
): void {
  const available = new Set(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
  const agents = [
    ...config.reviewers.map((reviewer, index) => ({ ...reviewer, label: `Reviewer ${index + 1}` })),
    { ...config.chair, label: "Chair" },
  ];
  const errors: string[] = [];
  for (const agent of agents) {
    const slash = agent.model.indexOf("/");
    const model = runtime.getModel(agent.model.slice(0, slash), agent.model.slice(slash + 1));
    if (!model) {
      errors.push(`${agent.label}: unknown model ${agent.model}`);
    } else if (!available.has(agent.model)) {
      errors.push(`${agent.label}: model ${agent.model} is unavailable; check provider authentication and model access`);
    }
  }
  if (errors.length > 0) {
    throw new ConfigurationError(`Council preflight failed:\n${errors.join("\n")}`);
  }
}
