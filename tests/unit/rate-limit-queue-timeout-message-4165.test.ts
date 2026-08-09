/**
 * #4165 — surface a clear error when the request-queue (Bottleneck) drops a job.
 *
 * Queue waiting is bounded by a separate timer. Bottleneck's job expiration is
 * intentionally not used because it measures the entire scheduled lifetime and
 * would kill an already-dispatched provider call that is making progress.
 *
 * The queue-only timer still rewrites pre-dispatch expiry into a clear,
 * OmniRoute-owned error that names the knob (`resilienceSettings.requestQueue.maxWaitMs`)
 * and explicitly says it is NOT an upstream timeout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rl-queue-timeout-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const resilienceSettings = await import("../../src/lib/resilience/settings.ts");
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Leave enough scheduling headroom for a loaded CI/devbox while keeping the
// executing callback longer than the queue-only budget. The actual queued-job
// case stays short because it controls dispatch deterministically.
const DISPATCHED_QUEUE_BUDGET_MS = 2_000;
const QUEUED_QUEUE_BUDGET_MS = 250;

test.afterEach(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// A dispatched provider call may run longer than maxWaitMs without being killed.
async function triggerQueueTimeout() {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
    concurrentRequests: 1,
    requestsPerMinute: 100000,
    minTimeBetweenRequestsMs: 0,
    maxWaitMs: DISPATCHED_QUEUE_BUDGET_MS,
  });
  const connectionId = "conn-dispatched-timeout";
  rateLimitManager.enableRateLimitProtection(connectionId);

  let dispatched = false;
  const result = await rateLimitManager.withRateLimit(
    "test-provider",
    connectionId,
    null,
    async () => {
      dispatched = true;
      await wait(DISPATCHED_QUEUE_BUDGET_MS + 250);
      return "should-not-reach";
    }
  );
  return { dispatched, result };
}

async function triggerQueuedTimeout() {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
    concurrentRequests: 1,
    requestsPerMinute: 0,
    minTimeBetweenRequestsMs: 0,
    maxWaitMs: QUEUED_QUEUE_BUDGET_MS,
  });
  const connectionId = "conn-queued-timeout";
  rateLimitManager.enableRateLimitProtection(connectionId);

  let resolveFirstExecuting: () => void = () => undefined;
  const firstExecuting = new Promise<void>((resolve) => {
    resolveFirstExecuting = resolve;
  });
  let releaseFirst: () => void = () => undefined;
  const first = rateLimitManager.withRateLimit("test-provider", connectionId, null, async () => {
    resolveFirstExecuting();
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  });
  await firstExecuting;

  let caught: unknown;
  let queuedDispatched = false;
  try {
    await rateLimitManager.withRateLimit("test-provider", connectionId, null, async () => {
      queuedDispatched = true;
      return "should-not-dispatch";
    });
    assert.fail("expected the queued job to expire");
  } catch (error) {
    caught = error;
  } finally {
    releaseFirst();
    await first;
  }
  return { caught, queuedDispatched };
}

test("#4165 a dispatched provider call is not killed by the queue budget", async () => {
  const execution = await triggerQueueTimeout();
  assert.equal(execution.dispatched, true, "the callback must enter execution");
  assert.equal(execution.result, "should-not-reach");
});

test("#4165 queue expiry surfaces a clear local error", async () => {
  const result = await triggerQueuedTimeout();
  assert.ok(result.caught instanceof Error, "queue expiry must reject with an Error");
  assert.equal(result.queuedDispatched, false, "an expired queued callback must never dispatch");
  const caught = result.caught as Error & { code?: string };
  assert.equal(caught.code, "RATE_LIMIT_QUEUE_TIMEOUT");
  assert.match(caught.message, /maxWaitMs/);
  assert.match(caught.message, /not an upstream/i);
  assert.doesNotMatch(caught.message, /This job timed out/);
});

test("#4165 a job that completes within maxWaitMs is unaffected", async () => {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
    concurrentRequests: 1,
    requestsPerMinute: 100000,
    minTimeBetweenRequestsMs: 0,
    maxWaitMs: 5000,
  });
  rateLimitManager.enableRateLimitProtection("conn-fast");

  const result = await rateLimitManager.withRateLimit(
    "openai",
    "conn-fast",
    "gpt-4o",
    async () => "ok"
  );
  assert.equal(result, "ok");
});
