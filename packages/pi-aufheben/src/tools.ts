import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { z } from "zod";
import type { AufhebenController } from "./controller.js";
import { acceptedAntithesisSchema, acceptedThesisSchema, antithesisInputSchema, briefSchema,
  checkpointInputSchema, synthesisSchema, thesisInputSchema, toolSchema } from "./protocol.js";
import { addUsage } from "./state.js";
import { compactResult, expandedResult } from "./rendering.js";
import { displayText } from "./progress.js";

export const outputSchema = z.object({
  state: z.object({ explorationId: z.string(), round: z.number(), expectedRevision: z.number(),
    phase: z.string(), lifecycle: z.string(), question: z.string(), brief: briefSchema.nullable(), focus: z.string(),
    thesis: acceptedThesisSchema.nullable(), antithesis: acceptedAntithesisSchema.nullable(), synthesis: synthesisSchema.nullable(),
  }).strict().nullable(),
  replayed: z.boolean(), error: z.string().nullable(),
}).strict();

export type ToolOutput = z.infer<typeof outputSchema>;

export function registerTools(pi: ExtensionAPI, controller: AufhebenController): void {
  const definitions = [
    { kind: "thesis" as const, schema: thesisInputSchema, description: "Ask the persistent Thesizer for reasoned research claims. Requires a user-authorized thesis phase. Resolve conversation references into an explicit research brief first." },
    { kind: "antithesis" as const, schema: antithesisInputSchema, description: "Ask the persistent Antithesizer for reasoned questions about the accepted current thesis. Use the expectedRevision returned by the previous Aufheben tool." },
    { kind: "checkpoint" as const, schema: checkpointInputSchema, description: "Save YOUR synthesis with complete_round, or save a user-requested brief adjustment with update_brief while paused/waiting. This tool does not call a Synthesizer model or authorize another round." },
  ];
  for (const definition of definitions) {
    pi.registerTool({
      name: `aufheben_${definition.kind}`, label: `Aufheben ${definition.kind}`, description: definition.description,
      parameters: toolSchema(definition.schema), outputSchema: toolSchema(outputSchema),
      exposure: "model-only", executionMode: "sequential",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: definition.kind !== "checkpoint" },
      renderResult(result, options) {
        const parsed = outputSchema.safeParse(result.structuredContent);
        if (!parsed.success) return new Text(displayText(result.content.filter((part) => part.type === "text")
          .map((part) => part.text).join("\n"), 300), 0, 0);
        return options.expanded ? new Markdown(expandedResult(parsed.data), 0, 0, getMarkdownTheme())
          : new Text(compactResult(parsed.data), 0, 0);
      },
      async execute(_id, input, signal, onUpdate, ctx) {
        const outcome = await controller.execute(definition.kind, input, ctx, signal, (phase) => onUpdate?.({
          content: [{ type: "text", text: `Aufheben ${definition.kind}: ${phase}` }],
          details: { version: 1, results: [], phase },
        }));
        const output = outputSchema.parse({ state: outcome.state, replayed: outcome.replayed, error: outcome.error });
        const usage = outcome.results.reduce((total, entry) => addUsage(total, entry.usage), null as ReturnType<typeof addUsage>);
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          details: { version: 1, results: outcome.results, explorationId: outcome.state?.explorationId ?? null },
          ...(usage ? { usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens, cost: usage.cost,
            ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
            ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
          } } : {}), ...(outcome.error ? { isError: true } : {}),
        };
      },
    });
  }
}
