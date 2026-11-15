import { logger } from "../../utils/logger.js";

export interface AttachedSessionState {
  sessionId: string;
  directory: string;
  busy: boolean;
}

export class AttachManager {
  private sessions = new Map<string, AttachedSessionState>();
  // The session most recently attached; the one the dashboard and the legacy
  // single-slot accessors speak about. Kept for callers that never learned about
  // multiple sessions.
  private foregroundId: string | null = null;

  attach(sessionId: string, directory: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.directory = directory;
    } else {
      this.sessions.set(sessionId, {
        sessionId,
        directory,
        busy: false,
      });
    }

    this.foregroundId = sessionId;
    logger.info(`[Attach] Attached to session: session=${sessionId}, directory=${directory}`);
  }

  /**
   * Removes one attached session. When it was the foreground, the last
   * remaining session (the most recently attached) takes the foreground, so an
   * attached session always has a valid foreground; only an empty map leaves
   * none.
   */
  detach(sessionId: string, reason: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    logger.info(
      `[Attach] Detached session: reason=${reason}, session=${sessionId}, directory=${state.directory}`,
    );
    this.sessions.delete(sessionId);
    if (this.foregroundId === sessionId) {
      this.foregroundId = this.lastSessionId();
    }
  }

  /** The most recently attached session still in the map, or null when it is empty. */
  private lastSessionId(): string | null {
    let last: string | null = null;
    for (const id of this.sessions.keys()) {
      last = id;
    }
    return last;
  }

  /** Copies of every attached slot, in attach order. */
  listSnapshots(): AttachedSessionState[] {
    return [...this.sessions.values()].map((state) => ({ ...state }));
  }

  clear(reason: string): void {
    if (this.sessions.size === 0) {
      return;
    }

    const ids = [...this.sessions.keys()].join(", ");
    logger.info(`[Attach] Cleared attached sessions: reason=${reason}, sessions=${ids}`);
    this.sessions.clear();
    this.foregroundId = null;
  }

  getSnapshot(): AttachedSessionState | null {
    const state = this.foregroundId ? this.sessions.get(this.foregroundId) : undefined;
    return state ? { ...state } : null;
  }

  getSnapshotFor(sessionId: string): AttachedSessionState | null {
    const state = this.sessions.get(sessionId);
    return state ? { ...state } : null;
  }

  isAttached(): boolean {
    return this.sessions.size > 0;
  }

  isAttachedSession(sessionId: string | null | undefined, directory?: string): boolean {
    if (!sessionId) {
      return false;
    }

    const state = this.sessions.get(sessionId);
    if (!state) {
      return false;
    }

    if (directory && state.directory !== directory) {
      return false;
    }

    return true;
  }

  isBusy(): boolean {
    for (const state of this.sessions.values()) {
      if (state.busy) {
        return true;
      }
    }
    return false;
  }

  markBusy(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return false;
    }

    if (state.busy) {
      return false;
    }

    state.busy = true;
    logger.info(`[Attach] Marked attached session busy: session=${sessionId}`);
    return true;
  }

  markIdle(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return false;
    }

    if (!state.busy) {
      return false;
    }

    state.busy = false;
    logger.info(`[Attach] Marked attached session idle: session=${sessionId}`);
    return true;
  }
}
