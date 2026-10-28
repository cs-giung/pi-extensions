import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codexUsageExtension from "../src/index.js";
import {
  CodexAuthUnavailableError,
  extractAccountId,
  fetchCodexUsage,
  parseCodexUsage,
  type CodexUsage,
} from "../src/api.js";
import { formatCodexStatus } from "../src/format.js";

type Handler = (event: unknown, ctx: ExtensionContext) => void;

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as ExtensionContext["ui"]["theme"];

let codexHome: string;
beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), "pi-usage-codex-"));
  vi.stubEnv("CODEX_HOME", codexHome);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(codexHome, { recursive: true, force: true });
});

describe("pi-usage-codex", () => {
  it("uses Pi OAuth auth and selects the regular quota windows", async () => {
    const token = jwtWithAccount("acct-123");
    const request = vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 18, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: "36", reset_after_seconds: 3600 },
      },
    }), { status: 200 }));

    const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: token }, source: "OAuth" }));
    const usage = await fetchCodexUsage({ getProviderAuth }, "gpt-5.6-sol", request as typeof fetch);

    expect(getProviderAuth).toHaveBeenCalledExactlyOnceWith("openai");

    expect(extractAccountId(token)).toBe("acct-123");
    expect(request).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": "acct-123",
        }),
      }),
    );
    expect(usage).toMatchObject({
      label: "codex",
      primary: { usedPercent: 18, windowSeconds: 18_000 },
      secondary: { usedPercent: 36 },
    });
  });

  it.each(["stored", "OPENAI_API_KEY", undefined])(
    "never sends an OpenAI API key to ChatGPT (source: %s)",
    async (source) => {
      const getProviderAuth = vi.fn(async (provider: string) => provider === "openai"
        ? { auth: { apiKey: jwtWithAccount("not-subscription-auth") }, ...(source ? { source } : {}) }
        : undefined);
      const request = vi.fn();

      await expect(fetchCodexUsage({ getProviderAuth }, "codex", request)).rejects.toBeInstanceOf(
        CodexAuthUnavailableError,
      );
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "   ", "invalid-token"])("hides missing or invalid OpenAI OAuth tokens (%s) without requesting usage", async (apiKey) => {
    const request = vi.fn();
    const getProviderAuth = vi.fn(async () => apiKey === undefined ? undefined : { auth: { apiKey }, source: "OAuth" });
    await expect(fetchCodexUsage({ getProviderAuth }, "codex", request)).rejects.toBeInstanceOf(
      CodexAuthUnavailableError,
    );
    expect(getProviderAuth.mock.calls).toEqual([["openai"], ["openai-codex"]]);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not fetch if cancelled while resolving OpenAI OAuth", async () => {
    const controller = new AbortController();
    const getProviderAuth = vi.fn(async (provider: string) => {
      if (provider !== "openai") return undefined;
      controller.abort();
      return { auth: { apiKey: jwtWithAccount("chatgpt-account") }, source: "OAuth" };
    });
    const request = vi.fn();
    await expect(fetchCodexUsage(
      { getProviderAuth }, "codex", request, controller.signal,
    )).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("falls back from new Pi OAuth to legacy Pi Codex OAuth", async () => {
    const token = jwtWithAccount("legacy-account");
    const getProviderAuth = vi.fn(async (provider: string) => ({
      auth: { apiKey: provider === "openai" ? encryptedJwt() : token }, source: "OAuth",
    }));
    const request = usageRequest();
    const usage = await fetchCodexUsage({ getProviderAuth }, "codex", request);
    expect(usage.authSource).toBe("Pi openai-codex");
    expect(getProviderAuth.mock.calls).toEqual([["openai"], ["openai-codex"]]);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${token}`, "chatgpt-account-id": "legacy-account",
    });
  });

  it("continues to legacy Pi OAuth when OpenAI credential resolution fails", async () => {
    const token = jwtWithAccount("legacy-account");
    const getProviderAuth = vi.fn(async (provider: string) => {
      if (provider === "openai") throw new Error("private-refresh-token");
      return { auth: { apiKey: token }, source: "OAuth" };
    });
    const request = usageRequest();
    expect(await fetchCodexUsage({ getProviderAuth }, "codex", request)).toMatchObject({ authSource: "Pi openai-codex" });
    expect(getProviderAuth.mock.calls).toEqual([["openai"], ["openai-codex"]]);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${token}`, "chatgpt-account-id": "legacy-account",
    });
  });

  it("uses read-only CLI auth even when both Pi credential resolvers fail", async () => {
    const token = jwtWithAccount("cli-account");
    const contents = JSON.stringify({ auth_mode: "chatgpt", tokens: {
      access_token: token, account_id: "cli-account", refresh_token: "private-cli-refresh-token",
    } });
    await writeFile(join(codexHome, "auth.json"), contents);
    const getProviderAuth = vi.fn(async (_provider: string) => { throw new Error("private-pi-credential-error"); });
    const request = usageRequest();
    expect(await fetchCodexUsage({ getProviderAuth }, "codex", request)).toMatchObject({ authSource: "Codex CLI" });
    expect(getProviderAuth.mock.calls).toEqual([["openai"], ["openai-codex"]]);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${token}`, "chatgpt-account-id": "cli-account",
    });
    expect(await readFile(join(codexHome, "auth.json"), "utf8")).toBe(contents);
  });

  it("reports transient Pi resolution failures without exposing credential errors or treating them as missing auth", async () => {
    const getProviderAuth = vi.fn(async () => { throw new Error("private-refresh-token"); });
    const request = vi.fn();
    const error = await fetchCodexUsage({ getProviderAuth }, "codex", request).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CodexAuthUnavailableError);
    expect((error as Error).message).toBe("Pi OAuth resolution failed and Codex CLI credentials are missing");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not fall back if cancellation rejects a Pi credential lookup", async () => {
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: jwtWithAccount("cli-account") } }));
    const controller = new AbortController();
    const reason = new Error("Cancelled by user");
    const getProviderAuth = vi.fn(async (_provider: string) => {
      controller.abort(reason);
      throw new Error("private-credential-error");
    });
    const request = vi.fn();
    await expect(fetchCodexUsage({ getProviderAuth }, "codex", request, controller.signal)).rejects.toBe(reason);
    expect(getProviderAuth).toHaveBeenCalledExactlyOnceWith("openai");
    expect(request).not.toHaveBeenCalled();
  });

  it("reads CLI ChatGPT auth when new Pi OAuth has no account ID, without modifying the file", async () => {
    const token = jwtWithAccount("cli-account");
    const contents = JSON.stringify({ auth_mode: "chatgpt", tokens: {
      access_token: token, account_id: "cli-account", refresh_token: "private-refresh-token",
    } });
    await writeFile(join(codexHome, "auth.json"), contents);
    const getProviderAuth = vi.fn(async (provider: string) => provider === "openai"
      ? { auth: { apiKey: encryptedJwt() }, source: "OAuth" } : undefined);
    const request = usageRequest();
    expect(await fetchCodexUsage({ getProviderAuth }, "codex", request)).toMatchObject({
      authSource: "Codex CLI", primary: { usedPercent: 20 },
    });
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${token}`, "chatgpt-account-id": "cli-account",
    });
    expect(await readFile(join(codexHome, "auth.json"), "utf8")).toBe(contents);
  });

  it("prefers compatible Pi OAuth over CLI credentials for another account", async () => {
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: jwtWithAccount("cli-account"), account_id: "cli-account" },
    }));
    const token = jwtWithAccount("pi-account");
    const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: token }, source: "OAuth" }));
    const request = usageRequest();
    expect((await fetchCodexUsage({ getProviderAuth }, "codex", request)).authSource).toBe("Pi openai");
    expect(getProviderAuth).toHaveBeenCalledExactlyOnceWith("openai");
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${token}`, "chatgpt-account-id": "pi-account",
    });
  });

  it("does not switch to a different CLI account after an HTTP authentication failure", async () => {
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: jwtWithAccount("cli-account"), account_id: "cli-account" },
    }));
    const token = jwtWithAccount("pi-account");
    const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: token }, source: "OAuth" }));
    const request = vi.fn(async () => new Response("private response body", { status: 401 }));
    await expect(fetchCodexUsage({ getProviderAuth }, "codex", request)).rejects.toMatchObject({ status: 401 });
    expect(getProviderAuth).toHaveBeenCalledExactlyOnceWith("openai");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps cached quota stale and backs off after Pi resolution fails without CLI auth", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: jwtWithAccount("pi-account") }, source: "OAuth" }));
    const request = usageRequest();
    let currentRequest: Promise<CodexUsage> | undefined;
    const loadUsage = vi.fn<typeof fetchCodexUsage>((registry, model, _fetch, signal) => {
      currentRequest = fetchCodexUsage(registry, model, request, signal);
      return currentRequest;
    });
    const handlers: Partial<Record<string, Handler>> = {};
    const setStatus = vi.fn();
    const ctx = { hasUI: true, modelRegistry: { getProviderAuth }, ui: { setStatus, theme } } as unknown as ExtensionContext;
    codexUsageExtension({ registerCommand: vi.fn(), on: (name: string, handler: Handler) => { handlers[name] = handler; } } as unknown as ExtensionAPI,
      { loadUsage, refreshIntervalMs: 1000 });
    try {
      handlers.session_start?.({}, ctx);
      await vi.advanceTimersByTimeAsync(0);
      expect(setStatus).toHaveBeenLastCalledWith("usage-codex", "codex 80%");
      getProviderAuth.mockRejectedValue(new Error("private-refresh-token"));
      await vi.advanceTimersByTimeAsync(1000);
      // File I/O runs on real time even while polling timers are simulated.
      await expect(currentRequest).rejects.toThrow("Pi OAuth resolution failed");
      await vi.advanceTimersByTimeAsync(0);
      expect(setStatus).toHaveBeenLastCalledWith("usage-codex", "codex 80% (stale)");
      expect(loadUsage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(loadUsage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(loadUsage).toHaveBeenCalledTimes(3);
      await expect(currentRequest).rejects.toThrow("Pi OAuth resolution failed");
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
    } finally { handlers.session_shutdown?.({}, ctx); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not read CLI credentials or fetch after cancellation during legacy OAuth resolution", async () => {
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: jwtWithAccount("cli-account") },
    }));
    const controller = new AbortController();
    const getProviderAuth = vi.fn(async (provider: string) => {
      if (provider === "openai") return { auth: { apiKey: encryptedJwt() }, source: "OAuth" };
      controller.abort();
      return undefined;
    });
    const request = vi.fn();
    await expect(fetchCodexUsage({ getProviderAuth }, "codex", request, controller.signal)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("reports incompatible Pi OAuth when no Codex credentials exist", async () => {
    const getProviderAuth = vi.fn(async (provider: string) => provider === "openai"
      ? { auth: { apiKey: encryptedJwt() }, source: "OAuth" } : undefined);
    const request = vi.fn();
    await expect(fetchCodexUsage({ getProviderAuth }, "codex", request)).rejects.toMatchObject({
      reason: "incompatible_oauth",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "not-json-private-secret",
    JSON.stringify({ OPENAI_API_KEY: "private-api-key" }),
    JSON.stringify({ auth_mode: "apikey", tokens: { access_token: jwtWithAccount("account") } }),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "invalid-private-token" } }),
    JSON.stringify({ tokens: { access_token: jwtWithAccount("account"), account_id: "different" } }),
  ])("never sends invalid or API-key CLI credentials (%#)", async (contents) => {
    await writeFile(join(codexHome, "auth.json"), contents);
    const request = vi.fn();
    await expect(fetchCodexUsage({ getProviderAuth: async () => undefined }, "codex", request))
      .rejects.toMatchObject({ reason: "codex_cli_unavailable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not send or refresh expired CLI credentials", async () => {
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: jwtWithAccount("account", 1), refresh_token: "private-refresh-token" },
    }));
    const request = vi.fn();
    await expect(fetchCodexUsage({ getProviderAuth: async () => undefined }, "codex", request))
      .rejects.toMatchObject({ reason: "codex_cli_expired" });
    expect(request).not.toHaveBeenCalled();
  });

  it("selects Spark's additional bucket and formats compact remaining quota", () => {
    const now = Date.UTC(2026, 6, 22, 0, 0, 0);
    const usage = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 90 },
      },
      additional_rate_limits: [{
        limit_name: "GPT-5.3-Codex-Spark",
        rate_limit: {
          primary_window: { used_percent: 9, limit_window_seconds: 18_000 },
          secondary_window: {
            used_percent: 27,
            limit_window_seconds: 604_800,
            reset_at: (now + 2 * 86_400_000 + 3 * 3_600_000) / 1000,
          },
        },
      }],
    }, "gpt-5.3-codex-spark", now);

    expect(formatCodexStatus(usage, theme, now)).toBe("spark 5h 91% · 7d 73% ↺2d3h");
  });

  it("loads on another provider and remains visible when the provider changes", async () => {
    const handlers: Partial<Record<string, Handler>> = {};
    const setStatus = vi.fn();
    const usage: CodexUsage = {
      label: "codex",
      primary: { usedPercent: 20 },
      secondary: { usedPercent: 40 },
    };
    const loadUsage = vi.fn(async () => usage);
    const pi = {
      registerCommand: vi.fn(),
      on: (name: string, handler: Handler) => {
        handlers[name] = handler;
      },
    } as unknown as ExtensionAPI;
    const model = { provider: "anthropic", id: "test" };
    const ctx = {
      hasUI: true,
      model,
      modelRegistry: {},
      ui: { setStatus, theme },
    } as unknown as ExtensionContext;

    codexUsageExtension(pi, { loadUsage, refreshIntervalMs: 3_600_000 });
    handlers.session_start?.({}, ctx);
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith(
      "usage-codex",
      "codex 5h 80% · 7d 60%",
    ));

    handlers.model_select?.({ model: { provider: "deepseek", id: "deepseek-v4-pro" } }, ctx);
    expect(setStatus).toHaveBeenLastCalledWith("usage-codex", "codex 5h 80% · 7d 60%");
    handlers.session_shutdown?.({}, ctx);
  });
});

function jwtWithAccount(accountId: string, exp?: number): string {
  const payload = Buffer.from(JSON.stringify({
    ...(exp === undefined ? {} : { exp }),
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function encryptedJwt(): string {
  return `header.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { encrypted_auth_metadata: "private-metadata" },
  })).toString("base64url")}.signature`;
}

function usageRequest() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
    rate_limit: { primary_window: { used_percent: 20 } },
  }), { status: 200 }));
}
