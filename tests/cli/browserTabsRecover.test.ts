import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";

const baseMeta = {
  id: "sess-recover",
  createdAt: "2026-05-26T00:00:00.000Z",
  status: "completed",
  options: {},
  mode: "browser",
  cwd: "/tmp/recover-cwd",
  browser: {
    config: {
      manualLogin: true,
      manualLoginProfileDir: "/tmp/recover-profile",
    },
    runtime: {
      tabUrl: "https://chatgpt.com/c/saved-conversation",
      conversationId: "saved-conversation",
    },
  },
} as unknown as SessionMetadata;

const completedHarvest = {
  targetId: "target-x",
  url: "https://chatgpt.com/c/saved-conversation",
  conversationId: "saved-conversation",
  state: "completed",
  authenticated: true,
  stopExists: false,
  sendExists: true,
  assistantCount: 1,
  currentModelLabel: "GPT-5.5 Pro",
  lastAssistantMarkdown: "## Recovered answer\n\nFull response captured.",
  lastAssistantText: "Recovered answer. Full response captured.",
  lastAssistantSnippet: "Recovered answer.",
  lastUserSnippet: "original prompt",
} as const;

describe("harvestSessionBrowserOutput recovery fallback", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("harvest waits for stale-stop stability before persisting stopped running sessions", async () => {
    const fullAnswer = "Full advisor answer recovered from ChatGPT. ".repeat(220).trim();
    const harvestChatGptTab = vi.fn(async (options: { stallWindowMs?: number }) => ({
      ...completedHarvest,
      stopExists: true,
      state: options.stallWindowMs && options.stallWindowMs > 0 ? "stalled" : "running",
      lastAssistantMarkdown: fullAnswer,
      lastAssistantText: fullAnswer,
      lastAssistantSnippet: "Full advisor answer recovered from ChatGPT.",
    }));
    const updateSession = vi.fn(async () => {});
    const tmp = await import("node:os").then((os) => os.tmpdir());
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const outfile = path.join(tmp, `oracle-harvest-${Date.now()}-${Math.random()}.md`);

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => "saved-conversation",
      formatBrowserTabState: (tab: { state?: string }) => tab.state ?? "running",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab: vi.fn(),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: async () => ({ ...baseMeta, status: "running" }),
        updateSession,
        sessionsDir: () => path.join(tmp, "oracle-sessions"),
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", {
      writeOutputPath: outfile,
      quietOutput: true,
    });

    expect(harvestChatGptTab).toHaveBeenCalledWith(
      expect.objectContaining({ stallWindowMs: expect.any(Number) }),
    );
    expect(await fs.readFile(outfile, "utf8")).toBe(fullAnswer);
    expect(updateSession).toHaveBeenCalledWith(
      "sess-recover",
      expect.objectContaining({
        browser: expect.objectContaining({
          harvest: expect.objectContaining({ state: "stalled", stopExists: true }),
        }),
      }),
    );
    await fs.unlink(outfile).catch(() => undefined);
  });

  test("retries via recoverConversationTab when initial harvest finds no live tab", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('No ChatGPT tab matched "https://chatgpt.com/c/saved-conversation".'),
      )
      .mockResolvedValueOnce(completedHarvest);

    const fakeChrome = { kill: vi.fn() };
    const recoverConversationTab = vi.fn(async (meta: SessionMetadata) => ({
      host: "127.0.0.1",
      port: 53999,
      url: meta.browser?.runtime?.tabUrl ?? "",
      chrome: fakeChrome,
    }));

    const updateSession = vi.fn(async () => {});
    const readSession = vi.fn(async () => baseMeta);

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession, updateSession },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
    expect(recoverConversationTab).toHaveBeenCalledTimes(1);
    expect(recoverConversationTab).toHaveBeenCalledWith(baseMeta, expect.any(Function));
    // After recovery, harvest is retried against the recovered endpoint/url.
    expect(harvestChatGptTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 53999,
        ref: "https://chatgpt.com/c/saved-conversation",
      }),
    );
    expect(result.lastAssistantMarkdown).toBe(completedHarvest.lastAssistantMarkdown);
    expect(updateSession).toHaveBeenCalled();
    // Default closeAfterRecover is false — Chrome stays alive for the user.
    expect(fakeChrome.kill).not.toHaveBeenCalled();
  });

  test("waits for recovered conversation hydration before accepting empty harvest", async () => {
    vi.useFakeTimers();
    try {
      const emptyHydratingHarvest = {
        targetId: "target-x",
        url: "https://chatgpt.com/c/saved-conversation",
        conversationId: "saved-conversation",
        state: "completed",
        authenticated: true,
        stopExists: false,
        sendExists: true,
        assistantCount: 0,
        currentModelLabel: "Pro Extended",
        lastAssistantMarkdown: null,
        lastAssistantText: "",
        lastAssistantSnippet: "",
        lastUserSnippet: "",
      } as const;
      const harvestChatGptTab = vi
        .fn()
        .mockRejectedValueOnce(new Error("No ChatGPT tab matched"))
        .mockResolvedValueOnce(emptyHydratingHarvest)
        .mockResolvedValueOnce(completedHarvest);
      const fakeChrome = { kill: vi.fn() };
      vi.doMock("../../src/browser/liveTabs.js", () => ({
        collectChatGptTabs: vi.fn(),
        DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
        DEFAULT_REMOTE_CHROME_PORT: 9222,
        extractConversationIdFromUrl: () => "saved-conversation",
        formatBrowserTabState: () => "completed",
        harvestChatGptTab,
        sessionMatchesTab: () => false,
      }));
      vi.doMock("../../src/browser/recoverConversation.js", () => ({
        recoverConversationTab: vi.fn(async () => ({
          host: "127.0.0.1",
          port: 53777,
          url: "https://chatgpt.com/c/saved-conversation",
          chrome: fakeChrome,
        })),
      }));
      vi.doMock("../../src/sessionStore.js", () => ({
        sessionStore: { readSession: async () => baseMeta, updateSession: async () => {} },
      }));

      const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
      const promise = harvestSessionBrowserOutput("sess-recover", {
        closeAfterRecover: true,
        quietOutput: true,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(promise).resolves.toMatchObject({
        lastAssistantText: completedHarvest.lastAssistantText,
      });
      expect(harvestChatGptTab).toHaveBeenCalledTimes(3);
      expect(fakeChrome.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not recover when recoverIfMissing is false; surfaces the original error", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched stuff"));
    const recoverConversationTab = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {} },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { recoverIfMissing: false, quietOutput: true }),
    ).rejects.toThrow(/No ChatGPT tab matched/);
    expect(recoverConversationTab).not.toHaveBeenCalled();
  });

  test("closes the recovered Chrome when closeAfterRecover is true", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched"))
      .mockResolvedValueOnce(completedHarvest);
    const fakeChrome = { kill: vi.fn() };
    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab: vi.fn(async () => ({
        host: "127.0.0.1",
        port: 53777,
        url: "https://chatgpt.com/c/saved-conversation",
        chrome: fakeChrome,
      })),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {} },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", {
      closeAfterRecover: true,
      quietOutput: true,
    });
    expect(fakeChrome.kill).toHaveBeenCalledTimes(1);
  });
});
