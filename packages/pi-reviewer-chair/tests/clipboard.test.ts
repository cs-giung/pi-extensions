import { describe, expect, it, vi } from "vitest";
import {
  copyTextPortable,
  type ClipboardRuntime,
} from "../src/clipboard.js";

function createRuntime(overrides: Partial<ClipboardRuntime> = {}): ClipboardRuntime {
  return {
    platform: "linux",
    env: {},
    copyWithPi: vi.fn(async () => undefined),
    runCommand: vi.fn(),
    writeTerminal: vi.fn(),
    ...overrides,
  };
}

describe("copyTextPortable", () => {
  it("uses native platform commands for local macOS and Windows sessions", async () => {
    for (const [platform, command, method] of [
      ["darwin", "pbcopy", "macos"],
      ["win32", "clip", "windows"],
    ] as const) {
      const runtime = createRuntime({ platform });

      await expect(copyTextPortable("Chair answer", runtime)).resolves.toEqual({
        method,
        terminal: false,
      });
      expect(runtime.runCommand).toHaveBeenCalledWith(command, [], "Chair answer");
      expect(runtime.copyWithPi).not.toHaveBeenCalled();
    }
  });

  it("uses tmux clipboard forwarding for multiplexed sessions", async () => {
    const runtime = createRuntime({
      env: { SSH_CONNECTION: "client server", TMUX: "/tmp/tmux" },
    });

    await expect(copyTextPortable("Chair answer", runtime)).resolves.toEqual({
      method: "tmux",
      terminal: true,
    });
    expect(runtime.runCommand).toHaveBeenCalledWith(
      "tmux",
      ["load-buffer", "-w", "-"],
      "Chair answer",
    );
    expect(runtime.copyWithPi).not.toHaveBeenCalled();
  });

  it("falls back to a tmux-wrapped OSC 52 sequence", async () => {
    const runtime = createRuntime({
      env: { SSH_CONNECTION: "client server", TMUX: "/tmp/tmux" },
      runCommand: vi.fn(() => {
        throw new Error("unsupported tmux version");
      }),
    });

    await expect(copyTextPortable("Chair answer", runtime)).resolves.toEqual({
      method: "osc52",
      terminal: true,
    });
    expect(runtime.writeTerminal).toHaveBeenCalledWith(
      expect.stringMatching(/^\u001bPtmux;\u001b\u001b\]52;c;/),
    );
  });

  it("uses raw OSC 52 for SSH and Mosh terminal clients", async () => {
    for (const env of [
      { SSH_CONNECTION: "client server" },
      { MOSH_CONNECTION: "client server" },
    ]) {
      const runtime = createRuntime({ env });

      await expect(copyTextPortable("Chair answer", runtime)).resolves.toEqual({
        method: "osc52",
        terminal: true,
      });
      expect(runtime.writeTerminal).toHaveBeenCalledWith(
        `\u001b]52;c;${Buffer.from("Chair answer").toString("base64")}\u0007`,
      );
    }
  });

  it("uses the Windows host clipboard from local WSL", async () => {
    const runtime = createRuntime({ env: { WSL_DISTRO_NAME: "Ubuntu" } });

    await expect(copyTextPortable("Chair answer", runtime)).resolves.toEqual({
      method: "windows",
      terminal: false,
    });
    expect(runtime.runCommand).toHaveBeenCalledWith("clip.exe", [], "Chair answer");
    expect(runtime.writeTerminal).not.toHaveBeenCalled();
  });

  it("falls back to Pi's clipboard utility for local Linux sessions", async () => {
    const runtime = createRuntime();

    await expect(copyTextPortable("Chair answer", runtime)).resolves.toEqual({
      method: "pi",
      terminal: false,
    });
    expect(runtime.copyWithPi).toHaveBeenCalledWith("Chair answer");
    expect(runtime.writeTerminal).not.toHaveBeenCalled();
  });

  it("reports when remote content exceeds the safe terminal limit", async () => {
    const runtime = createRuntime({ env: { SSH_CONNECTION: "client server" } });

    await expect(copyTextPortable("x".repeat(80_000), runtime)).rejects.toThrow(
      /too large for safe OSC 52 transport/,
    );
  });
});
