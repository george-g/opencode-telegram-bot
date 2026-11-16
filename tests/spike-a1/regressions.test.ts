import { beforeEach, describe, expect, it } from "vitest";
import type { Context } from "grammy";
import { AttachManager } from "../../src/app/managers/attach-manager.js";
import { SummaryAggregator } from "../../src/app/managers/summary-aggregation-manager.js";
import { detachOneAttachedSession } from "../../src/app/services/attach-service.js";
import { isForegroundBusy } from "../../src/app/services/run-control-service.js";
import { resolveInteractionGuardDecision } from "../../src/bot/middleware/interaction-guard-decision.js";
import { createTestAppContainer } from "../helpers/app-container.js";
import { startInteractionForTest } from "../helpers/interaction.js";

/**
 * The scope the guard resolves for a context without a chat: chat 0 with no forum
 * topic.
 */
const SCOPE = "0:no-thread";

/** Regression coverage for the A1 review: detach/unfollow state and two-session busy. */
describe("spike-a1/regressions", () => {
  describe("attach-manager detach keeps a valid foreground", () => {
    let manager: AttachManager;

    beforeEach(() => {
      manager = new AttachManager();
    });

    it("picks the remaining session as foreground when the foreground is detached", () => {
      manager.attach("session-1", "D:/repo");
      manager.attach("session-2", "D:/repo");

      manager.detach("session-2", "test");

      expect(manager.getSnapshot()).toMatchObject({ sessionId: "session-1" });
      expect(manager.isAttached()).toBe(true);
      expect(manager.isAttachedSession("session-1")).toBe(true);
      expect(manager.isAttachedSession("session-2")).toBe(false);
    });

    it("leaves no foreground only when the last session is detached", () => {
      manager.attach("session-1", "D:/repo");

      manager.detach("session-1", "test");

      expect(manager.getSnapshot()).toBeNull();
      expect(manager.isAttached()).toBe(false);
    });

    it("keeps the detached non-foreground session's detach from touching the foreground", () => {
      manager.attach("session-1", "D:/repo");
      manager.attach("session-2", "D:/repo");

      manager.detach("session-1", "test");

      expect(manager.getSnapshot()).toMatchObject({ sessionId: "session-2" });
    });

    it("lists copies of every attached slot", () => {
      manager.attach("session-1", "D:/repo");
      manager.attach("session-2", "D:/other");

      const snapshots = manager.listSnapshots();

      expect(snapshots).toEqual([
        { sessionId: "session-1", directory: "D:/repo", busy: false },
        { sessionId: "session-2", directory: "D:/other", busy: false },
      ]);

      // A copy: mutating it does not change the manager.
      snapshots[0]!.busy = true;
      expect(manager.getSnapshotFor("session-1")?.busy).toBe(false);
    });

    it("isBusy is true when any session is busy, and false once all are idle", () => {
      manager.attach("session-1", "D:/repo");
      manager.attach("session-2", "D:/repo");

      expect(manager.isBusy()).toBe(false);
      manager.markBusy("session-1");
      expect(manager.isBusy()).toBe(true);
      manager.markIdle("session-1");
      expect(manager.isBusy()).toBe(false);
      manager.markBusy("session-2");
      expect(manager.isBusy()).toBe(true);
    });
  });

  describe("unfollowing the primary session", () => {
    type AggregatorInternals = { currentSessionId: string | null };
    let aggregator: SummaryAggregator;

    beforeEach(() => {
      aggregator = new SummaryAggregator();
      aggregator.setOnCleared(() => {});
    });

    const currentSessionId = (): string | null =>
      (aggregator as unknown as AggregatorInternals).currentSessionId;

    it("moves the primary to another followed session and clears the old primary's state", () => {
      aggregator.setSession("session-1");
      aggregator.followSession("session-2");
      aggregator.registerRestoredPermissionChild("child-1", "session-1");

      aggregator.unfollowSession("session-1");

      expect(currentSessionId()).toBe("session-2");
      expect(aggregator.isFollowed("session-1")).toBe(false);
      expect(aggregator.isSubagentSession("child-1")).toBe(false);
    });

    it("empties the primary when the last followed session is unfollowed", () => {
      aggregator.setSession("session-1");

      aggregator.unfollowSession("session-1");

      expect(currentSessionId()).toBeNull();
    });

    it("does not touch the primary when a non-primary session is unfollowed", () => {
      aggregator.setSession("session-1");
      aggregator.followSession("session-2");
      aggregator.registerRestoredPermissionChild("child-1", "session-1");

      aggregator.unfollowSession("session-2");

      expect(currentSessionId()).toBe("session-1");
      expect(aggregator.isSubagentSession("child-1")).toBe(true);
    });
  });

  describe("disconnect one session", () => {
    it("unfollows only the disconnected session and detaches it from the manager", () => {
      const container = createTestAppContainer();
      container.attachManager.attach("session-1", "D:/repo");
      container.attachManager.attach("session-2", "D:/repo");
      container.summaryAggregator.setSession("session-1");
      container.summaryAggregator.followSession("session-2");

      detachOneAttachedSession("session-1", "test", {
        attachManager: container.attachManager,
        summaryAggregator: container.summaryAggregator,
      });

      expect(container.summaryAggregator.isFollowed("session-1")).toBe(false);
      expect(container.summaryAggregator.isFollowed("session-2")).toBe(true);
      expect(container.attachManager.isAttachedSession("session-1")).toBe(false);
      expect(container.attachManager.isAttachedSession("session-2")).toBe(true);
      expect(container.attachManager.getSnapshot()).toMatchObject({ sessionId: "session-2" });
    });
  });

  describe("one attached session behaves as before", () => {
    it("reports busy, blocks the guard and clears when the single session is marked busy", () => {
      const container = createTestAppContainer();
      container.attachManager.attach("session-1", "D:/repo");

      expect(isForegroundBusy(container)).toBe(false);

      container.attachManager.markBusy("session-1");
      expect(isForegroundBusy(container)).toBe(true);

      const ctx = {
        message: { text: "hello" },
        callbackQuery: undefined,
      } as unknown as Context;
      const decision = resolveInteractionGuardDecision(ctx, container);
      expect(decision.busy).toBe(true);
      expect(decision.allow).toBe(false);

      container.attachManager.markIdle("session-1");
      expect(isForegroundBusy(container)).toBe(false);
    });

    it("keeps the busy gate keyed to the session that is busy", () => {
      const container = createTestAppContainer();
      container.attachManager.attach("session-1", "D:/repo");
      container.attachManager.markBusy("session-1");

      const idleCtx = { message: { text: "hello" } } as unknown as Context;
      expect(resolveInteractionGuardDecision(idleCtx, container).busy).toBe(true);
    });

    it("does not block on a session that was never attached", () => {
      const container = createTestAppContainer();

      expect(isForegroundBusy(container)).toBe(false);

      const ctx = { message: { text: "hello" } } as unknown as Context;
      const decision = resolveInteractionGuardDecision(ctx, container);
      expect(decision.busy).toBeFalsy();
      expect(decision.allow).toBe(true);
    });
  });

  describe("busy with two sessions", () => {
    it("sees a non-foreground attached session as busy through the guard", () => {
      const container = createTestAppContainer();
      container.attachManager.attach("session-1", "D:/repo");
      container.attachManager.attach("session-2", "D:/repo");
      // The second attach is the foreground; the first one carries the run.
      container.attachManager.markBusy("session-1");

      expect(isForegroundBusy(container)).toBe(true);

      const ctx = { message: { text: "hello" } } as unknown as Context;
      expect(resolveInteractionGuardDecision(ctx, container).busy).toBe(true);
    });

    it("keeps running session A's busy flag when session B is attached and idle", () => {
      const container = createTestAppContainer();
      container.attachManager.attach("session-1", "D:/repo");
      container.attachManager.markBusy("session-1");

      // A second session attaches: the foreground moves, A's busy flag must survive.
      container.attachManager.attach("session-2", "D:/repo");

      expect(container.attachManager.getSnapshotFor("session-1")?.busy).toBe(true);
      expect(container.attachManager.getSnapshotFor("session-2")?.busy).toBe(false);
      expect(isForegroundBusy(container)).toBe(true);
    });
  });

  describe("interaction while a second session is busy", () => {
    it("blocks input while a non-foreground session runs, matching the single-session gate", () => {
      const container = createTestAppContainer();
      container.interactionManager.clear("test_setup");
      startInteractionForTest(container.interactionManager, {
        kind: "inline",
        expectedInput: "callback",
      }, SCOPE);
      container.attachManager.attach("session-1", "D:/repo");
      container.attachManager.attach("session-2", "D:/repo");
      container.attachManager.markBusy("session-1");

      const ctx = { message: { text: "hello" } } as unknown as Context;
      const decision = resolveInteractionGuardDecision(ctx, container);

      expect(decision.busy).toBe(true);
      expect(decision.allow).toBe(false);
    });
  });
});
