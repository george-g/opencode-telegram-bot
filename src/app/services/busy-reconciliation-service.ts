import { opencodeClient } from "../../opencode/client.js";
import type { AppContainer } from "../bootstrap/app-container.js";
import type { AttachedSessionState } from "../managers/attach-manager.js";
import type { ForegroundBusySession } from "../managers/foreground-session-state-manager.js";
import { markAttachedSessionBusy, markAttachedSessionIdle } from "./attach-service.js";
import { logger } from "../../utils/logger.js";

const RECONCILE_MIN_INTERVAL_MS = 10_000;
const FOREGROUND_BUSY_RECONCILE_GRACE_MS = 2_000;

type SessionStatus = {
  type?: string;
};

type ResponseStreamerForReconciliation = {
  hasActiveStream(sessionId: string): boolean;
};

export type BusyReconciliationDeps = Pick<
  AppContainer,
  "attachManager" | "foregroundSessionState" | "scheduledTaskRuntime"
>;

const inFlightDirectories = new Set<string>();
const lastReconcileAtByDirectory = new Map<string, number>();

let responseStreamerInstance: ResponseStreamerForReconciliation | null = null;
let clearPromptResponseModeForReconciliation: ((sessionId: string) => void) | null = null;

export function setResponseStreamerForReconciliation(
  streamer: ResponseStreamerForReconciliation,
): void {
  responseStreamerInstance = streamer;
}

export function setPromptResponseModeClearerForReconciliation(
  clearer: (sessionId: string) => void,
): void {
  clearPromptResponseModeForReconciliation = clearer;
}

function getReconciliationTargets(
  directory: string,
  deps: BusyReconciliationDeps,
): {
  foregroundBusySessions: ForegroundBusySession[];
  attachedSessionsForDirectory: AttachedSessionState[];
} {
  const foregroundBusySessions = deps.foregroundSessionState
    .getBusySessions()
    .filter((session) => session.directory === directory);
  const attachedSessionsForDirectory = deps.attachManager
    .listSnapshots()
    .filter((session) => session.directory === directory);

  return { foregroundBusySessions, attachedSessionsForDirectory };
}

function getSessionStatus(
  statuses: Record<string, SessionStatus>,
  sessionId: string,
): SessionStatus | null {
  return statuses[sessionId] ?? null;
}

function isTerminalStatus(status: SessionStatus | null): boolean {
  return !status || status.type === "idle" || status.type === "error";
}

function isWithinForegroundBusyGracePeriod(
  session: ForegroundBusySession,
  now: number,
): boolean {
  return now - session.markedAt < FOREGROUND_BUSY_RECONCILE_GRACE_MS;
}

async function clearForegroundBusySession(
  sessionId: string,
  deps: BusyReconciliationDeps,
): Promise<void> {
  deps.foregroundSessionState.markIdle(sessionId);
  clearPromptResponseModeForReconciliation?.(sessionId);
}

export async function reconcileBusyStateNow(
  directory: string,
  deps: BusyReconciliationDeps,
  now: number = Date.now(),
): Promise<void> {
  if (!directory) {
    return;
  }

  const { foregroundBusySessions, attachedSessionsForDirectory } =
    getReconciliationTargets(directory, deps);

  if (foregroundBusySessions.length === 0 && attachedSessionsForDirectory.length === 0) {
    return;
  }

  const { data: statuses, error } = await opencodeClient.session.status({ directory });
  if (error || !statuses) {
    logger.warn("[BusyReconciliation] Failed to load session status", error);
    return;
  }

  const freshForegroundSessionIds = new Set(
    foregroundBusySessions
      .filter((session) => isWithinForegroundBusyGracePeriod(session, now))
      .map((session) => session.sessionId),
  );

  for (const attachedSession of attachedSessionsForDirectory) {
    const attachedStatus = getSessionStatus(statuses, attachedSession.sessionId);

    if (attachedStatus?.type === "busy") {
      await markAttachedSessionBusy(attachedSession.sessionId, deps);
    } else if (
      isTerminalStatus(attachedStatus) &&
      !freshForegroundSessionIds.has(attachedSession.sessionId)
    ) {
      await markAttachedSessionIdle(attachedSession.sessionId, deps);
    }
  }

  let clearedForegroundSession = false;
  for (const session of foregroundBusySessions) {
    const status = getSessionStatus(statuses, session.sessionId);
    if (!isTerminalStatus(status)) {
      continue;
    }

    if (freshForegroundSessionIds.has(session.sessionId)) {
      logger.debug(
        `[BusyReconciliation] Skipping fresh foreground busy state: session=${session.sessionId}, directory=${session.directory}, status=${status?.type ?? "not-found"}`,
      );
      continue;
    }

    if (responseStreamerInstance?.hasActiveStream(session.sessionId)) {
      logger.debug(
        `[BusyReconciliation] Skipping clear, responseStreamer still active: session=${session.sessionId}`,
      );
      continue;
    }

    logger.info(
      `[BusyReconciliation] Clearing stale foreground busy state: session=${session.sessionId}, directory=${session.directory}, status=${status?.type ?? "not-found"}`,
    );
    const sessionId = session.sessionId;
    if (!attachedSessionsForDirectory.some((attached) => attached.sessionId === sessionId)) {
      await markAttachedSessionIdle(sessionId, deps);
    }
    await clearForegroundBusySession(sessionId, deps);
    clearedForegroundSession = true;
  }

  if (clearedForegroundSession) {
    await deps.scheduledTaskRuntime.flushDeferredDeliveries();
  }
}

export async function reconcileBusyState(
  directory: string,
  deps: BusyReconciliationDeps,
  now: number = Date.now(),
): Promise<void> {
  if (!directory || inFlightDirectories.has(directory)) {
    return;
  }

  const { foregroundBusySessions, attachedSessionsForDirectory } =
    getReconciliationTargets(directory, deps);
  if (foregroundBusySessions.length === 0 && attachedSessionsForDirectory.length === 0) {
    return;
  }

  const lastReconcileAt = lastReconcileAtByDirectory.get(directory);
  if (lastReconcileAt !== undefined && now - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) {
    return;
  }

  lastReconcileAtByDirectory.set(directory, now);
  inFlightDirectories.add(directory);

  try {
    await reconcileBusyStateNow(directory, deps, now);
  } catch (error) {
    logger.warn("[BusyReconciliation] Failed to reconcile busy state", error);
  } finally {
    inFlightDirectories.delete(directory);
  }
}

export function __resetBusyReconciliationForTests(): void {
  inFlightDirectories.clear();
  lastReconcileAtByDirectory.clear();
  responseStreamerInstance = null;
  clearPromptResponseModeForReconciliation = null;
}
