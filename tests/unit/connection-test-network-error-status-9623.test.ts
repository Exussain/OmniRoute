/**
 * Regression for #9623: a connection test that fails because the request never
 * left the host must not persist testStatus='error'.
 *
 * Bug: testSingleConnection() wrote `testStatus: result.valid ? "active" : "error"`
 * for every failure, including the `network_error` diagnosis that classifyFailure()
 * returns for "fetch failed" / ENOTFOUND / ECONNREFUSED / timeouts. Those failures
 * mean the request never reached the upstream, so the test observed nothing about
 * the connection itself.
 *
 * That mattered because 'error' has no way back. Proactive recovery
 * (src/lib/quota/connectionRecovery.ts) restores a connection only when BOTH gates
 * pass: testStatus === 'unavailable' (line 85) AND an elapsed rateLimitedUntil
 * (line 87 — hasElapsedCooldown returns false on null). A failed test sets neither:
 * it writes 'error' and carries the previous rateLimitedUntil forward, which is null
 * for a healthy connection. So the rows fail both gates and stay red until someone
 * re-tests by hand. Measured after a host reboot: 20 connections across 6 providers
 * went red inside 0.823s and were still red 63 minutes later.
 *
 * Fix: keep whatever status the connection already had when the diagnosis is
 * network_error. The error fields still record the attempt, matching how
 * src/lib/tokenHealthCheck.ts already handles a transient refresh failure.
 *
 * This drives the REAL (unmocked) testSingleConnection() against a temp SQLite DB,
 * following tests/unit/apikey-connection-health-check.test.ts and
 * tests/unit/token-health-check-sweep.test.ts, since mock.module() is unavailable
 * in this tsx/ESM + Node native test-runner setup. Driving the whole function
 * rather than an extracted helper is deliberate: it is what makes this fail if the
 * write path stops consulting the diagnosis.
 *
 * The connection is OAuth/github because that path reaches a bare fetch() that a
 * stub can drive (same approach as tests/unit/oauth-connection-test-timeout.test.ts).
 * API-key providers return "Provider test not supported" here, since the provider
 * registry is not populated under the unit-test runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-9623-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      }
      break;
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw error;
      }
    }
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

/** An OAuth connection whose probe goes through a bare fetch() a stub can drive. */
async function createHealthyConnection(name: string) {
  return providersDb.createProviderConnection({
    provider: "github",
    name,
    authType: "oauth",
    accessToken: "fake-token-for-test",
    refreshToken: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    isActive: true,
    testStatus: "active",
  });
}

/** Replace fetch for one test and restore it afterwards. */
function stubFetch(t: { after: (fn: () => void) => void }, impl: () => Promise<Response>) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = impl as unknown as typeof fetch;
}

test("#9623: a network failure leaves testStatus alone instead of writing 'error'", async (t) => {
  await resetStorage();

  const conn = await createHealthyConnection("github-network-error-9623");
  assert.equal(conn.testStatus, "active", "precondition: connection starts active");

  // The shape undici produces when the host cannot reach the network at all.
  stubFetch(t, () => Promise.reject(new TypeError("fetch failed")));

  const result = await testSingleConnection(conn.id);
  assert.equal(result.valid, false, "precondition: the test must have failed");
  assert.equal(
    result.diagnosis?.code,
    "network_error",
    "precondition: the failure must be diagnosed as a network error"
  );

  const updated = await providersDb.getProviderConnectionById(conn.id);

  assert.equal(
    updated?.testStatus,
    "active",
    "a failure that never reached the upstream must not overwrite the connection status"
  );
  assert.equal(
    updated?.errorCode,
    "network_error",
    "the failed attempt is still recorded, so the operator can see the test did not succeed"
  );
  assert.ok(updated?.lastError, "lastError still carries the underlying message");
  assert.equal(
    updated?.rateLimitedUntil ?? null,
    null,
    "no cooldown is invented for a failure the connection did not cause"
  );
});

test("#9623: a probe that times out is also treated as never reaching the upstream", async (t) => {
  await resetStorage();

  const conn = await createHealthyConnection("github-timeout-9623");

  // testOAuthConnection turns an AbortSignal.timeout() abort into its own message,
  // "Test timed out after 30s" — which does not contain the substring "timeout",
  // so classifyFailure used to fall through to a generic upstream_error and the
  // connection was marked broken by a hang it never caused.
  stubFetch(t, () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    return Promise.reject(err);
  });

  const result = await testSingleConnection(conn.id);
  assert.equal(result.valid, false, "precondition: the test must have failed");
  assert.match(
    String(result.error),
    /timed out/i,
    "precondition: the OAuth probe reports its abort in its own wording"
  );
  assert.equal(
    result.diagnosis?.code,
    "network_error",
    "a timed-out probe never reached the upstream, so it is a network failure"
  );

  const updated = await providersDb.getProviderConnectionById(conn.id);
  assert.equal(updated?.testStatus, "active", "a hang must not mark the connection broken");
});

test("#9623: a real upstream rejection still marks the connection as error", async (t) => {
  await resetStorage();

  const conn = await createHealthyConnection("github-auth-error-9623");

  // A 401 is the upstream answering, so the test DID observe the connection.
  stubFetch(t, () =>
    Promise.resolve(
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    )
  );

  const result = await testSingleConnection(conn.id);
  assert.equal(result.valid, false, "precondition: the test must have failed");
  assert.notEqual(
    result.diagnosis?.code,
    "network_error",
    "precondition: an answered 401 is not a network failure"
  );

  const updated = await providersDb.getProviderConnectionById(conn.id);

  assert.equal(
    updated?.testStatus,
    "error",
    "an answered rejection is a real observation and must still mark the connection"
  );
});
