import type { SessionStore, SessionMetadata } from "../sessionStore.js";
import chalk from "chalk";

interface DuplicatePromptGuardOptions {
  prompt: string | undefined | null;
  browserFollowUps?: string[];
  force?: boolean;
  sessionStore: SessionStore;
  log?: (message: string) => void;
}

function isProcessAlive(pid?: number): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    return code === "EPERM";
  }
}

function isHarvestableOrphanedBrowserSession(entry: SessionMetadata): boolean {
  if (entry.mode !== "browser") return false;
  const runtime = entry.browser?.runtime ?? {};
  const harvest = entry.browser?.harvest ?? {};
  const controllerPid = runtime.controllerPid;
  if (typeof controllerPid !== "number" || isProcessAlive(controllerPid)) {
    return false;
  }
  const hasRecoverableTarget = Boolean(
    harvest.url ||
      runtime.tabUrl ||
      harvest.conversationId ||
      runtime.conversationId ||
      harvest.targetId ||
      runtime.chromeTargetId,
  );
  const hasHarvestEvidence = Boolean(
    harvest.assistantHash ||
      harvest.lastAssistantSnippet ||
      harvest.state === "stalled" ||
      harvest.state === "completed",
  );
  return hasRecoverableTarget && (runtime.promptSubmitted === true || hasHarvestEvidence);
}

function normalizeRunSignature(prompt: string, browserFollowUps?: string[]): string {
  const followUps = (browserFollowUps ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n\n--- browser follow-up ---\n\n");
  return [prompt.trim(), followUps].filter(Boolean).join("\n\n--- browser follow-ups ---\n\n");
}

export async function shouldBlockDuplicatePrompt({
  prompt,
  browserFollowUps,
  force,
  sessionStore,
  log = console.log,
}: DuplicatePromptGuardOptions): Promise<boolean> {
  if (force) return false;
  const normalized = prompt?.trim();
  if (!normalized) return false;
  const signature = normalizeRunSignature(normalized, browserFollowUps);

  const running = (await sessionStore.listSessions()).filter((entry) => entry.status === "running");
  const orphaned = running.filter((entry) => isHarvestableOrphanedBrowserSession(entry));
  const duplicate = running.filter((entry) => !orphaned.includes(entry)).find(
    (entry: SessionMetadata) =>
      normalizeRunSignature(
        entry.options?.prompt?.trim?.() ?? "",
        entry.options?.browserFollowUps,
      ) === signature,
  );
  if (!duplicate) {
    const matchingOrphan = orphaned.find(
      (entry: SessionMetadata) =>
        normalizeRunSignature(
          entry.options?.prompt?.trim?.() ?? "",
          entry.options?.browserFollowUps,
        ) === signature,
    );
    if (matchingOrphan) {
      log(
        chalk.yellow(
          `Skipping duplicate prompt guard for orphaned browser session (${matchingOrphan.id}); recover it with "oracle session ${matchingOrphan.id} --harvest" if you need the existing answer.`,
        ),
      );
    }
    return false;
  }

  log(
    chalk.yellow(
      `A session with the same prompt is already running (${duplicate.id}). Reattach with "oracle session ${duplicate.id}" or rerun with --force to start another run.`,
    ),
  );
  return true;
}
