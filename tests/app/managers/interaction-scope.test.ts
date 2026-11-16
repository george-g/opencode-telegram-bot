import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionManager } from "../../../src/app/managers/interaction-manager.js";
import { QuestionManager } from "../../../src/app/managers/question-manager.js";
import { PermissionManager } from "../../../src/app/managers/permission-manager.js";
import { RenameManager } from "../../../src/app/managers/rename-manager.js";
import type { PermissionRequest } from "../../../src/app/types/permission.js";
import type { Question } from "../../../src/app/types/question.js";

const SCOPE_A = "100:42";
const SCOPE_B = "100:43";
const SCOPE_GENERAL = "100:no-thread";
const SCOPE_OTHER_CHAT_GENERAL = "200:no-thread";

const QUESTIONS: Question[] = [
  { header: "Q", question: "Pick", options: [{ label: "A", description: "first" }] },
];

function permission(id: string, sessionID = "session-1"): PermissionRequest {
  return { id, sessionID, permission: "bash", patterns: [id], metadata: {}, always: [] };
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

let interactionManager: InteractionManager;
let questionManager: QuestionManager;
let permissionManager: PermissionManager;
let renameManager: RenameManager;

beforeEach(() => {
  interactionManager = new InteractionManager();
  questionManager = new QuestionManager(interactionManager);
  permissionManager = new PermissionManager(interactionManager);
  renameManager = new RenameManager(interactionManager);
});

describe("interaction manager per scope", () => {
  it("holds one slot per scope", () => {
    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_A);
    renameManager.startWaiting("session-1", "D:/repo", "Old title", SCOPE_B);

    expect(interactionManager.getSnapshot(SCOPE_A)?.kind).toBe("inline");
    expect(interactionManager.getSnapshot(SCOPE_B)?.kind).toBe("rename");
    expect(interactionManager.isActive(SCOPE_GENERAL)).toBe(false);
  });

  it("opens and closes the no-thread slot the same way as a topic slot", () => {
    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_GENERAL);

    expect(interactionManager.isActive(SCOPE_GENERAL)).toBe(true);
    expect(interactionManager.isActive(SCOPE_A)).toBe(false);

    interactionManager.clear("test", SCOPE_GENERAL);
    expect(interactionManager.isActive(SCOPE_GENERAL)).toBe(false);
  });

  it("keeps two chats with no thread id in two slots", () => {
    expect(SCOPE_GENERAL).not.toBe(SCOPE_OTHER_CHAT_GENERAL);

    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_GENERAL);
    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_OTHER_CHAT_GENERAL);

    interactionManager.clear("test", SCOPE_GENERAL);

    expect(interactionManager.isActive(SCOPE_GENERAL)).toBe(false);
    expect(interactionManager.isActive(SCOPE_OTHER_CHAT_GENERAL)).toBe(true);
  });

  it("clears only the named scope and leaves the others in place", () => {
    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_A);
    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_B);

    interactionManager.clear("test", SCOPE_A);

    expect(interactionManager.isActive(SCOPE_A)).toBe(false);
    expect(interactionManager.isActive(SCOPE_B)).toBe(true);
  });

  it("tracks expiry per scope", () => {
    const referenceTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(referenceTime);

    interactionManager.start({ kind: "inline", expectedInput: "callback", expiresInMs: 1000 }, SCOPE_A);
    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_B);

    vi.setSystemTime(referenceTime + 1001);
    expect(interactionManager.isExpired(referenceTime + 1001, SCOPE_A)).toBe(true);
    expect(interactionManager.isExpired(referenceTime + 1001, SCOPE_B)).toBe(false);

    vi.useRealTimers();
  });

  it("replaces only the slot of the same scope", () => {
    interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: { step: 1 } }, SCOPE_A);
    renameManager.startWaiting("session-1", "D:/repo", "Old title", SCOPE_B);
    interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: { step: 2 } }, SCOPE_A);

    expect(interactionManager.getSnapshot(SCOPE_A)?.metadata).toEqual({ step: 2 });
    expect(interactionManager.getSnapshot(SCOPE_B)?.kind).toBe("rename");
  });

  it("releases only the queue of the cleared scope", async () => {
    const listener = vi.fn();
    interactionManager.setOnWaitingRequestReady(listener);
    permissionManager.startPermission(permission("perm-a"), 101, undefined, SCOPE_A);
    interactionManager.waitQuestion(QUESTIONS, "req-a", "session-a", {}, SCOPE_A);
    interactionManager.waitPermission(permission("perm-b"), {}, SCOPE_B);

    interactionManager.clear("test", SCOPE_A);
    await nextTick();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      { kind: "question", questions: QUESTIONS, requestID: "req-a", sessionId: "session-a" },
      0,
    );
    // The waiting permission of the other scope stays queued.
    expect(interactionManager.getWaitingPermissionRequestIds()).toEqual(["perm-b"]);
  });

  it("releases a scope's waiting request when its own slot is cleared", async () => {
    const listener = vi.fn();
    interactionManager.setOnWaitingRequestReady(listener);
    permissionManager.startPermission(permission("perm-a"), 101, undefined, SCOPE_A);
    interactionManager.waitQuestion(QUESTIONS, "req-a", "session-a", {}, SCOPE_A);

    interactionManager.clear("test", SCOPE_A);
    await nextTick();

    expect(listener).toHaveBeenCalledWith(
      { kind: "question", questions: QUESTIONS, requestID: "req-a", sessionId: "session-a" },
      0,
    );
  });

  it("drops the waiting queue of every scope on a reset without a scope", () => {
    permissionManager.startPermission(permission("perm-a"), 101, undefined, SCOPE_A);
    interactionManager.waitQuestion(QUESTIONS, "req-a", "session-a", {}, SCOPE_A);
    interactionManager.waitPermission(permission("perm-b"), {}, SCOPE_B);

    interactionManager.reset("test_reset");

    expect(interactionManager.isActive(SCOPE_A)).toBe(false);
    expect(interactionManager.isActive(SCOPE_B)).toBe(false);
    expect(interactionManager.getWaitingKind()).toBeNull();
    expect(interactionManager.getWaitingQuestionRequestIds()).toEqual([]);
    expect(interactionManager.getWaitingPermissionRequestIds()).toEqual([]);
  });

  it("drops only the named scope on a scoped reset", () => {
    permissionManager.startPermission(permission("perm-a"), 101, undefined, SCOPE_A);
    interactionManager.waitQuestion(QUESTIONS, "req-a", "session-a", {}, SCOPE_A);
    permissionManager.startPermission(permission("perm-b"), 102, undefined, SCOPE_B);
    interactionManager.waitPermission(permission("perm-c"), {}, SCOPE_B);

    interactionManager.reset("test_reset", SCOPE_A);

    expect(interactionManager.isActive(SCOPE_A)).toBe(false);
    expect(interactionManager.getWaitingQuestionRequestIds()).toEqual([]);
    expect(interactionManager.isActive(SCOPE_B)).toBe(true);
    expect(interactionManager.getWaitingPermissionRequestIds()).toEqual(["perm-c"]);
  });

  it("reports a dropped poll of one scope without touching the poll of another", () => {
    const listener = vi.fn();
    interactionManager.setOnQuestionDropped(listener);

    questionManager.startQuestions(QUESTIONS, "req-a", "session-a", SCOPE_A);
    questionManager.startQuestions(QUESTIONS, "req-b", "session-b", SCOPE_B);

    interactionManager.reset("test_reset", SCOPE_A);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0].sessionId).toBe("session-a");
    expect(questionManager.isActive(SCOPE_B)).toBe(true);
  });

  it("scopes a rename flow so it does not block a question of another scope", () => {
    renameManager.startWaiting("session-1", "D:/repo", "Old title", SCOPE_A);

    expect(questionManager.startQuestions(QUESTIONS, "req-b", "session-b", SCOPE_B)).toBe(true);
    expect(renameManager.isWaitingForName(SCOPE_A)).toBe(true);
    expect(renameManager.isWaitingForName(SCOPE_B)).toBe(false);
  });

  it("reports every prompt and poll dropped by a full reset, across scopes", () => {
    const promptsListener = vi.fn();
    interactionManager.setOnPermissionPromptsDropped(promptsListener);

    permissionManager.startPermission(permission("perm-a"), 101, undefined, SCOPE_A);
    permissionManager.startPermission(permission("perm-b"), 102, undefined, SCOPE_B);

    interactionManager.reset("test_reset");

    expect(promptsListener).toHaveBeenCalledTimes(2);
    const messageIds = promptsListener.mock.calls.flatMap(([payload]) => [
      ...payload.requestsByMessageId.keys(),
    ]);
    expect(messageIds.sort()).toEqual([101, 102]);
  });

  it("bumps the global generation once per full reset", () => {
    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_A);
    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_B);
    const generation = interactionManager.getGeneration(SCOPE_A);

    interactionManager.reset("test_reset");

    expect(interactionManager.getGeneration(SCOPE_A)).toBe(generation + 1);
    expect(interactionManager.getGeneration(SCOPE_B)).toBe(generation + 1);
    // A scope that holds no state still follows the full reset.
    expect(interactionManager.getGeneration(SCOPE_GENERAL)).toBe(generation + 1);
    expect(interactionManager.getResetEpoch()).toBe(generation + 1);
  });

  it("bumps only the reset scope's generation on a scoped reset", () => {
    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_A);
    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_B);
    const generationOfA = interactionManager.getGeneration(SCOPE_A);
    const generationOfB = interactionManager.getGeneration(SCOPE_B);

    interactionManager.reset("test_reset", SCOPE_A);

    expect(interactionManager.getGeneration(SCOPE_A)).toBe(generationOfA + 1);
    expect(interactionManager.getGeneration(SCOPE_B)).toBe(generationOfB);
  });

  it("keeps another scope's in-flight await valid when one scope's permission clear runs", async () => {
    // The permission clear of B bumps only B's epoch. The prompt of A keeps its
    // generation, so its in-flight await is not dropped as stale.
    const listener = vi.fn();
    interactionManager.setOnWaitingRequestReady(listener);
    permissionManager.startPermission(permission("perm-b"), 102, undefined, SCOPE_B);
    interactionManager.waitQuestion(QUESTIONS, "req-a", "session-a", {}, SCOPE_A);
    const generationOfA = interactionManager.getGeneration(SCOPE_A);
    const generationOfB = interactionManager.getGeneration(SCOPE_B);

    interactionManager.clearErrorScope("permission", "test_cleanup", SCOPE_B);
    await nextTick();

    expect(interactionManager.getGeneration(SCOPE_A)).toBe(generationOfA);
    expect(interactionManager.getGeneration(SCOPE_B)).toBe(generationOfB + 1);
  });

  it("bumps only the cleared scope when a scope's permission clear runs", () => {
    // The F4 complaint: the permission clear of one scope moved the shared
    // generation, so an await in flight in another scope went stale.
    permissionManager.startPermission(permission("perm-b"), 102, undefined, SCOPE_B);
    interactionManager.start({ kind: "inline", expectedInput: "callback" }, SCOPE_A);
    const generationOfA = interactionManager.getGeneration(SCOPE_A);
    const generationOfB = interactionManager.getGeneration(SCOPE_B);

    permissionManager.clear(SCOPE_B);

    expect(interactionManager.getGeneration(SCOPE_A)).toBe(generationOfA);
    expect(interactionManager.getGeneration(SCOPE_B)).toBe(generationOfB + 1);
  });

  it("clears a failed handler's scope without touching another scope", () => {
    questionManager.startQuestions(QUESTIONS, "req-a", "session-a", SCOPE_A);
    questionManager.startQuestions(QUESTIONS, "req-b", "session-b", SCOPE_B);

    interactionManager.clearErrorScope("question", "test_cleanup", SCOPE_A);

    expect(questionManager.isActive(SCOPE_A)).toBe(false);
    expect(questionManager.isActive(SCOPE_B)).toBe(true);
  });
});
