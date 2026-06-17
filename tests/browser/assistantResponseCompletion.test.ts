import { describe, expect, test, vi } from "vitest";
import { pollAssistantCompletionForTest } from "../../src/browser/actions/assistantResponse.js";
import type { ChromeClient } from "../../src/browser/types.js";

// Regression coverage for the ChatGPT "Pro Extended" early-capture bug: a reasoning
// model can leave a single visible token (e.g. "I") frozen on the DOM for minutes
// while the actual reasoning happens off-DOM. During that window neither the stop
// button nor the completion UI is present, so the snapshot poller must NOT treat the
// frozen short text as a finished answer on pure stability alone.

type EvalParams = { expression?: string; returnByValue?: boolean };

function snapshotResult(text: string) {
  return {
    result: {
      value: { text, html: "", messageId: "mid", turnId: "tid", turnIndex: 0 },
    },
  };
}

function boolResult(value: boolean) {
  return { result: { value } };
}

// pollAssistantCompletion issues exactly three Runtime.evaluate kinds per cycle:
//   1. snapshot read   -> expression embeds the extractAssistantTurn extractor
//   2. completion probe -> expression references lastAssistantTurn
//   3. stop-button probe -> expression queries [data-testid="stop-button"]
// The snapshot expression also mentions the stop selector, so it must be matched first.
function buildRuntime(opts: {
  snapshotText: () => string;
  completionVisible: () => boolean;
  stopVisible?: () => boolean;
}): ChromeClient["Runtime"] {
  const stopVisible = opts.stopVisible ?? (() => false);
  return {
    evaluate: vi.fn(async (params: EvalParams) => {
      const expr = String(params?.expression ?? "");
      if (expr.includes("extractAssistantTurn")) {
        return snapshotResult(opts.snapshotText());
      }
      if (expr.includes("lastAssistantTurn")) {
        return boolResult(opts.completionVisible());
      }
      if (expr.includes("stop-button")) {
        return boolResult(stopVisible());
      }
      return boolResult(false);
    }),
  } as unknown as ChromeClient["Runtime"];
}

describe("pollAssistantCompletion completion gating", () => {
  test("does not complete a 1-char answer without a completion signal (Pro Extended regression)", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const runtime = buildRuntime({
        snapshotText: () => "I",
        completionVisible: () => false,
      });

      let resolved: boolean = false;
      let resolvedValue: unknown = "sentinel";
      const promise = pollAssistantCompletionForTest(
        runtime,
        60_000,
        undefined,
        undefined,
        controller.signal,
      ).then((value) => {
        resolved = true;
        resolvedValue = value;
        return value;
      });

      // Drive far past the 8s short-answer stability window. Before the fix the poller
      // returned "I" here; after the fix it keeps waiting for a positive completion signal.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(resolved).toBe(false);

      // Teardown: abort so the watchdog loop exits cleanly and resolves to null.
      controller.abort();
      await vi.advanceTimersByTimeAsync(500);
      await promise;
      expect(resolvedValue).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("completes with the full answer once it grows long and the completion UI appears", async () => {
    vi.useFakeTimers();
    try {
      const LONG = "This is a sufficiently long completed assistant answer.";
      let calls = 0;
      const runtime = buildRuntime({
        snapshotText: () => {
          calls += 1;
          // First couple of reads show only the frozen first token, then the real answer streams in.
          return calls <= 2 ? "I" : LONG;
        },
        completionVisible: () => true,
      });

      const promise = pollAssistantCompletionForTest(runtime, 60_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(promise).resolves.toMatchObject({ text: LONG });
    } finally {
      vi.useRealTimers();
    }
  });

  test("completes a genuinely short answer when the completion UI is present", async () => {
    vi.useFakeTimers();
    try {
      const runtime = buildRuntime({
        snapshotText: () => "OK",
        completionVisible: () => true,
      });

      // Short text is allowed to complete, but only via the positive completion signal
      // (completionEnough), never via stability alone.
      const promise = pollAssistantCompletionForTest(runtime, 60_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(promise).resolves.toMatchObject({ text: "OK" });
    } finally {
      vi.useRealTimers();
    }
  });
});
