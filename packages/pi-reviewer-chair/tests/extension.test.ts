import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import reviewerChairExtension from "../src/index.js";

interface TestCommand {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

describe("Reviewer Chair extension", () => {
  it("registers Council execution and explicit raw-response disclosure commands", async () => {
    const commands = new Map<string, TestCommand>();
    const sendMessage = vi.fn();
    const on = vi.fn();
    const copyText = vi.fn(async (_text: string) => ({
      method: "macos" as const,
      terminal: false,
    }));
    const extensionApi = {
      registerCommand: (name: string, command: TestCommand) => commands.set(name, command),
      on,
      sendMessage,
    } as unknown as ExtensionAPI;
    reviewerChairExtension(extensionApi, copyText);

    expect([...commands.keys()]).toEqual(["council-reviews", "council-copy", "council"]);
    expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));

    const notify = vi.fn();
    await commands.get("council-reviews")?.handler("", {
      ui: { notify },
    } as unknown as ExtensionCommandContext);

    expect(notify).toHaveBeenCalledWith(
      "No completed Reviewer run is available. Run /council first.",
      "warning",
    );
    expect(sendMessage).not.toHaveBeenCalled();

    const copyNotify = vi.fn();
    await commands.get("council-copy")?.handler("", {
      sessionManager: {
        getEntries: () => [
          { type: "custom_message", customType: "reviewer-chair-final", content: "Older" },
          { type: "custom_message", customType: "other", content: "Ignore" },
          { type: "custom_message", customType: "reviewer-chair-final", content: "Latest" },
        ],
      },
      ui: { notify: copyNotify },
    } as unknown as ExtensionCommandContext);

    expect(copyText).toHaveBeenCalledWith("Latest");
    expect(copyNotify).toHaveBeenCalledWith(
      "Copied the most recent Chair answer via macOS pbcopy.",
      "info",
    );
  });
});
