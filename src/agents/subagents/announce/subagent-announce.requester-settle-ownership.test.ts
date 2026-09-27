import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

const { registryRuntimeMock, deliverSpy, gatewayContextControl } = vi.hoisted(() => ({
  registryRuntimeMock: {
    countActiveDescendantRuns: vi.fn(() => 0),
    hasDescendantRunAwaitingSettle: vi.fn(() => false),
    listSubagentRunsForRequester: vi.fn<() => SubagentRunRecord[]>(() => []),
    getLatestSubagentRunByChildSessionKey: vi.fn(() => undefined),
    getLatestLiveSubagentRunByChildSessionKey: vi.fn(() => undefined),
  },
  deliverSpy: vi.fn<(params: Record<string, unknown>) => Promise<SubagentAnnounceDeliveryResult>>(),
  // Undefined keeps the pre-existing "no captured gateway owner" path, where an
  // unavailable owner spends no delivery budget. Tests that need a captured owner
  // install a resolver here and retire it again afterwards.
  gatewayContextControl: { current: undefined as { context?: unknown } | undefined },
}));

vi.mock("../../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../registry/subagent-registry-read.js", () => registryRuntimeMock);
vi.mock("../spawn/subagent-depth.js", () => ({ getSubagentDepthFromSessionStore: () => 0 }));
vi.mock("./subagent-announce.js", () => ({ hasUsableSessionEntry: () => true }));
vi.mock("../../../plugins/runtime/gateway-request-scope.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../plugins/runtime/gateway-request-scope.js")>();
  return {
    ...actual,
    getSharedGatewayContextResolver: () => gatewayContextControl.current,
  };
});
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (params: Record<string, unknown>) => deliverSpy(params),
  loadRequesterSessionEntry: () => ({
    entry: { sessionId: "sess-main" },
    canonicalKey: "agent:main:main",
  }),
}));

import {
  maybeWakeRequesterAfterAllChildrenSettled,
  type RequesterSettleWakeBatchState,
} from "./subagent-announce.requester-settle-wake.js";

const REQUESTER = "agent:main:main";

function makeSettledChild(
  overrides: Pick<SubagentRunRecord, "runId"> & Partial<SubagentRunRecord>,
): SubagentRunRecord {
  const { runId, ...record } = overrides;
  return {
    runId,
    childSessionKey: "agent:main:subagent:" + runId,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000 },
    expectsCompletionMessage: true,
    delivery: { status: "delivered" },
    requesterSettleWake: { status: "pending", attemptCount: 0 },
    ...record,
  };
}

function transitionBatch(
  batch: readonly SubagentRunRecord[],
  state: RequesterSettleWakeBatchState,
): void {
  for (const entry of batch) {
    if (entry.requesterSettleWake) {
      entry.requesterSettleWake = {
        ...state,
        ...(entry.requesterSettleWake.retireAfterSettle ? { retireAfterSettle: true } : {}),
      };
    }
  }
}

function completeBatch(batch: readonly SubagentRunRecord[], rearmGeneration?: number): void {
  for (const entry of batch) {
    if (entry.requesterSettleWake?.rearmGeneration === rearmGeneration) {
      entry.requesterSettleWake = undefined;
    }
  }
}

function wakeParams() {
  const settledEntry = registryRuntimeMock
    .listSubagentRunsForRequester()
    .find((entry) => entry.runId === "run-b");
  if (!settledEntry) {
    throw new Error("The control requires its registered run-b fixture.");
  }
  return { requesterSessionKey: REQUESTER, settledEntry, transitionBatch, completeBatch };
}

beforeEach(() => {
  registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
  deliverSpy.mockReset().mockResolvedValue({ delivered: true, path: "direct" });
  gatewayContextControl.current = undefined;
});
afterEach(() => {
  gatewayContextControl.current = undefined;
  publishSystemEventStoreResolver(undefined);
});

it.each(["same", "before admission", "during admission"] as const)(
  "keeps yielded requester wakes in their captured store: %s",
  async (replacement) => {
    const child = makeSettledChild({
      runId: "run-b",
      requesterStorePath: "original-store",
      completion: { required: true, resultText: "retained child result" },
      delivery: { status: "suspended", suspendedReason: "permanent_failure" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
    publishSystemEventStoreResolver(() =>
      replacement === "before admission" ? "replacement-store" : "original-store",
    );
    const admitted = createDeferred();
    const execute = createDeferred();
    const startedTurns: string[] = [];
    deliverSpy.mockImplementationOnce(async (params) => {
      admitted.resolve();
      await execute.promise;
      const allowed = params.isSourceSessionEffectsAllowed;
      if (typeof allowed === "function" && !allowed()) {
        return { delivered: false, path: "none", disposition: "intentional_non_delivery" };
      }
      startedTurns.push(REQUESTER);
      return { delivered: true, path: "direct" };
    });
    const complete = vi.fn((batch: readonly SubagentRunRecord[], generation?: number) =>
      completeBatch(batch, generation),
    );
    const pending = maybeWakeRequesterAfterAllChildrenSettled({
      ...wakeParams(),
      completeBatch: complete,
    });
    try {
      if (replacement !== "before admission") {
        await admitted.promise;
        publishSystemEventStoreResolver(() =>
          replacement === "same" ? "original-store" : "replacement-store",
        );
      }
      execute.resolve();
      expect(await pending).toBe(replacement === "same");
      expect(startedTurns).toEqual(replacement === "same" ? [REQUESTER] : []);
      expect(child.requesterSettleWake).toBeUndefined();
      expect(child.completion?.resultText).toBe("retained child result");
      if (replacement !== "same") {
        expect(complete).toHaveBeenCalledWith(
          [child],
          1,
          expect.objectContaining({
            error: "store replaced",
            disposition: "intentional_non_delivery",
          }),
          expect.any(Function),
        );
      }
    } finally {
      execute.resolve();
      await pending;
    }
  },
);

it("closes the frozen requester obligation when reset suppresses an unfinished member", async () => {
  const batchRunIds = ["run-a", "run-b"];
  const wake = {
    status: "pending" as const,
    attemptCount: 0,
    batchRunIds,
    requesterYieldBatch: true as const,
    rearmGeneration: 7,
  };
  const cancelled = makeSettledChild({
    runId: "run-a",
    requesterSettleWake: { ...wake },
    killReconciliation: { killedAt: 3_000, suppressTaskDelivery: true },
  });
  // Reset leaves completed records intact, but their shared requester was stopped.
  const completed = makeSettledChild({
    runId: "run-b",
    requesterSettleWake: { ...wake },
    completion: { required: true, resultText: "completed sibling result" },
  });
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([cancelled, completed]);
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
  expect(deliverSpy).not.toHaveBeenCalled();
  expect(cancelled.requesterSettleWake).toBeUndefined();
  expect(completed.requesterSettleWake).toBeUndefined();
  expect(completed.completion?.resultText).toBe("completed sibling result");
});

it("leaves a rearmed yielded batch intact when an older queued wake loses authority", async () => {
  const child = makeSettledChild({
    runId: "run-b",
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
    },
  });
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
  const admitted = createDeferred();
  const execute = createDeferred();
  const startedTurns: string[] = [];
  deliverSpy.mockImplementationOnce(async (params) => {
    admitted.resolve();
    await execute.promise;
    const allowed = params.isSourceSessionEffectsAllowed;
    if (typeof allowed === "function" && !allowed()) {
      return {
        delivered: false,
        path: "none",
        disposition: "intentional_non_delivery",
      };
    }
    startedTurns.push(REQUESTER);
    return { delivered: true, path: "direct" };
  });
  const pending = maybeWakeRequesterAfterAllChildrenSettled(wakeParams());
  try {
    await admitted.promise;
    transitionBatch([child], {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 2,
    });
    execute.resolve();
    expect(await pending).toBe(false);
    expect(startedTurns).toEqual([]);
    expect(child.requesterSettleWake).toMatchObject({
      status: "pending",
      attemptCount: 0,
      rearmGeneration: 2,
    });
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
    expect(child.requesterSettleWake).toBeUndefined();
  } finally {
    execute.resolve();
    await pending;
  }
});

it("defers a revoked dispatch instead of stranding the wake without a deadline", async () => {
  const child = makeSettledChild({
    runId: "run-b",
    requesterStorePath: "original-store",
    completion: { required: true, resultText: "retained child result" },
    // The shape from #159429: the child has ended and its own delivery attempt was
    // closed, but a yield batch still owns waking the requester for the result.
    delivery: { status: "pending", disposition: "intentional_non_delivery" },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: ["run-b"],
    },
  });
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
  publishSystemEventStoreResolver(() => "original-store");

  // A Gateway owner is captured when the dispatch is admitted, then goes away
  // before the transport reports back. That revokes the dispatch in flight.
  const capturedOwner: { context?: unknown } = { context: { id: "gateway-owner" } };
  gatewayContextControl.current = capturedOwner;
  deliverSpy.mockImplementationOnce(async () => {
    capturedOwner.context = undefined;
    return { delivered: false, path: "none", disposition: "intentional_non_delivery" };
  });
  const complete = vi.fn((batch: readonly SubagentRunRecord[], generation?: number) =>
    completeBatch(batch, generation),
  );

  expect(
    await maybeWakeRequesterAfterAllChildrenSettled({ ...wakeParams(), completeBatch: complete }),
  ).toBe(false);

  // Admission alone leaves the wake at `dispatching` with no deadline, and that
  // state can never advance: the attempt cap is unreachable from it and the
  // sweeper only re-dispatches. A revoked dispatch must record the retry
  // deadline and start the bounded deferral budget instead.
  expect(child.requesterSettleWake).toMatchObject({
    nextAttemptAt: expect.any(Number),
    deferralCount: 1,
  });
  // The obligation is deferred, not settled: the result is still owned and the
  // batch must not be consumed while its owner is gone.
  expect(complete).not.toHaveBeenCalled();
  expect(child.completion?.resultText).toBe("retained child result");
});
