import { beforeEach, describe, expect, it } from "vitest";
import { AttachManager } from "../../../src/app/managers/attach-manager.js";

describe("attach-manager/multi-session", () => {
  let manager: AttachManager;

  beforeEach(() => {
    manager = new AttachManager();
  });

  it("keeps every session attached and reports the last one as the foreground snapshot", () => {
    manager.attach("session-1", "D:/repo");
    manager.attach("session-2", "D:/repo");

    expect(manager.getSnapshot()).toMatchObject({ sessionId: "session-2", busy: false });
    expect(manager.isAttachedSession("session-1")).toBe(true);
    expect(manager.isAttachedSession("session-2")).toBe(true);
    expect(manager.getSnapshotFor("session-1")).toMatchObject({ sessionId: "session-1" });
  });

  it("checks a session's directory only when one is given", () => {
    manager.attach("session-1", "D:/repo");

    expect(manager.isAttachedSession("session-1", "D:/repo")).toBe(true);
    expect(manager.isAttachedSession("session-1", "D:/other")).toBe(false);
  });

  it("marks busy and idle per session, and isBusy is true when any session is busy", () => {
    manager.attach("session-1", "D:/repo");
    manager.attach("session-2", "D:/repo");

    expect(manager.markBusy("session-1")).toBe(true);
    expect(manager.getSnapshotFor("session-1")?.busy).toBe(true);
    // Busy speaks about every attached session, not only the foreground one.
    expect(manager.isBusy()).toBe(true);
    expect(manager.markBusy("session-1")).toBe(false);
    expect(manager.markIdle("session-1")).toBe(true);
    expect(manager.markIdle("session-1")).toBe(false);
    expect(manager.isBusy()).toBe(false);
  });

  it("detaches one session and leaves the others; a detached foreground leaves none", () => {
    manager.attach("session-1", "D:/repo");
    manager.attach("session-2", "D:/repo");

    manager.detach("session-1", "test");
    expect(manager.isAttachedSession("session-1")).toBe(false);
    expect(manager.isAttachedSession("session-2")).toBe(true);
    expect(manager.getSnapshot()).toMatchObject({ sessionId: "session-2" });

    manager.detach("session-2", "test");
    expect(manager.getSnapshot()).toBeNull();
    expect(manager.isAttached()).toBe(false);
  });

  it("clears every session at once", () => {
    manager.attach("session-1", "D:/repo");
    manager.attach("session-2", "D:/repo");
    manager.attach("session-3", "D:/repo");

    manager.clear("reset");

    expect(manager.isAttached()).toBe(false);
    expect(manager.getSnapshot()).toBeNull();
    expect(manager.getSnapshotFor("session-1")).toBeNull();
  });
});
