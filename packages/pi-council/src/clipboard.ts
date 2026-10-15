import { execFileSync } from "node:child_process";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";

const MAX_OSC52_ENCODED_LENGTH = 100_000;

export type ClipboardCopyMethod = "macos" | "windows" | "tmux" | "osc52" | "pi";

export interface ClipboardCopyResult {
  method: ClipboardCopyMethod;
  terminal: boolean;
}

export interface ClipboardRuntime {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  copyWithPi: (text: string) => Promise<void>;
  runCommand: (command: string, args: readonly string[], input: string) => void;
  writeTerminal: (sequence: string) => void;
}

const DEFAULT_RUNTIME: ClipboardRuntime = {
  platform: process.platform,
  env: process.env,
  copyWithPi: copyToClipboard,
  runCommand: (command, args, input) => {
    execFileSync(command, args, {
      input,
      timeout: 5_000,
      stdio: ["pipe", "ignore", "ignore"],
    });
  },
  writeTerminal: (sequence) => {
    process.stdout.write(sequence);
  },
};

export async function copyTextPortable(
  text: string,
  runtime: ClipboardRuntime = DEFAULT_RUNTIME,
): Promise<ClipboardCopyResult> {
  const failures: string[] = [];
  const remote = Boolean(
    runtime.env.SSH_CONNECTION || runtime.env.SSH_CLIENT || runtime.env.MOSH_CONNECTION,
  );
  const wsl = Boolean(runtime.env.WSL_DISTRO_NAME || runtime.env.WSL_INTEROP);

  if (!remote && runtime.platform === "darwin") {
    try {
      runtime.runCommand("pbcopy", [], text);
      return { method: "macos", terminal: false };
    } catch (error) {
      failures.push(`pbcopy: ${errorMessage(error)}`);
    }
  }

  if (!remote && runtime.platform === "win32") {
    try {
      runtime.runCommand("clip", [], text);
      return { method: "windows", terminal: false };
    } catch (error) {
      failures.push(`clip: ${errorMessage(error)}`);
    }
  }

  if (!remote && wsl) {
    try {
      runtime.runCommand("clip.exe", [], text);
      return { method: "windows", terminal: false };
    } catch (error) {
      failures.push(`clip.exe: ${errorMessage(error)}`);
    }
  }

  if (runtime.env.TMUX) {
    try {
      runtime.runCommand("tmux", ["load-buffer", "-w", "-"], text);
      return { method: "tmux", terminal: true };
    } catch (error) {
      failures.push(`tmux: ${errorMessage(error)}`);
    }
  }

  if (!remote && !wsl) {
    try {
      await runtime.copyWithPi(text);
      return { method: "pi", terminal: false };
    } catch (error) {
      failures.push(`system clipboard: ${errorMessage(error)}`);
    }
  }

  try {
    const encoded = Buffer.from(text).toString("base64");
    if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
      throw new Error("answer is too large for safe OSC 52 transport");
    }

    const sequence = runtime.env.TMUX
      ? `\u001bPtmux;\u001b\u001b]52;c;${encoded}\u0007\u001b\\`
      : runtime.env.STY
        ? `\u001bP\u001b]52;c;${encoded}\u0007\u001b\\`
        : `\u001b]52;c;${encoded}\u0007`;
    runtime.writeTerminal(sequence);
    return { method: "osc52", terminal: true };
  } catch (error) {
    failures.push(`OSC 52: ${errorMessage(error)}`);
  }

  throw new Error(`No clipboard strategy succeeded (${failures.join("; ")})`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
