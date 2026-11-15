import type { AppContainer } from "../bootstrap/app-container.js";
import { logger } from "../../utils/logger.js";
import {
  reconcileBusyStateNow,
  type BusyReconciliationDeps,
} from "./busy-reconciliation-service.js";

export type ForegroundBusyDeps = Pick<AppContainer, "attachManager" | "foregroundSessionState">;

export type RunControlDeps = ForegroundBusyDeps & BusyReconciliationDeps;

export function isForegroundBusy(deps: ForegroundBusyDeps): boolean {
  return deps.foregroundSessionState.isBusy() || deps.attachManager.isBusy();
}

function getBusyDirectories(deps: ForegroundBusyDeps): string[] {
  const directories = new Set<string>();

  for (const session of deps.foregroundSessionState.getBusySessions()) {
    directories.add(session.directory);
  }

  for (const session of deps.attachManager.listSnapshots()) {
    if (session.busy) {
      directories.add(session.directory);
    }
  }

  return [...directories];
}

export async function reconcileForegroundBusyState(deps: RunControlDeps): Promise<void> {
  if (!isForegroundBusy(deps)) {
    return;
  }

  for (const directory of getBusyDirectories(deps)) {
    try {
      await reconcileBusyStateNow(directory, deps);
    } catch (error) {
      logger.warn("[BusyGuard] Failed to reconcile foreground busy state", error);
    }
  }
}
