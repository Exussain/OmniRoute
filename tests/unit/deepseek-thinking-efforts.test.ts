import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-deepseek-efforts-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "deepseek-efforts-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");
const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { sanitizeReasoningEffortForProvider } = await import("../../open-sse/executors/base.ts");

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("DeepSeek registry declares the documented per-model thinking efforts", () => {
  const models = new Map((REGISTRY.deepseek?.models || []).map((model) => [model.id, model]));

  assert.deepEqual(models.get("deepseek-v4-flash")?.supportedThinkingEfforts, [
    "none",
    "low",
    "high",
    "max",
  ]);
  assert.deepEqual(models.get("deepseek-v4-pro")?.supportedThinkingEfforts, [
    "none",
    "high",
    "max",
  ]);
});

test("DeepSeek catalog exposes only the declared effort aliases", async () => {
  await providersDb.createProviderConnection({
    provider: "deepseek",
    authType: "apikey",
    name: "deepseek-efforts",
    apiKey: "deepseek-test-key",
    isActive: true,
    testStatus: "active",
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<{ id: string }> };
  const ids = new Set(body.data.map((model) => model.id));

  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-none")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-low")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-high")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-max")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-pro-none")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-pro-high")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-pro-max")));
  assert.equal(
    [...ids].some((id) => id.endsWith("deepseek-v4-pro-low")),
    false,
    "Pro does not advertise low"
  );
});

test("hardcoded DeepSeek effort suffixes resolve through the static registry", async () => {
  const flashLow = await getModelInfo("ds/deepseek-v4-flash-low");
  assert.equal(flashLow.provider, "deepseek");
  assert.equal(flashLow.model, "deepseek-v4-flash");
  assert.equal(flashLow.resolvedThinkingEffort, "low");

  const flashNone = await getModelInfo("deepseek/deepseek-v4-flash-none");
  assert.equal(flashNone.model, "deepseek-v4-flash");
  assert.equal(flashNone.resolvedThinkingEffort, "none");

  const unsupportedProLow = await getModelInfo("ds/deepseek-v4-pro-low");
  assert.equal(unsupportedProLow.model, "deepseek-v4-pro-low");
  assert.equal(unsupportedProLow.resolvedThinkingEffort, undefined);
});

test("native DeepSeek preserves Flash low while clamping unsupported Pro low", () => {
  const flash = sanitizeReasoningEffortForProvider(
    { model: "deepseek-v4-flash", reasoning_effort: "low" },
    "deepseek",
    "deepseek-v4-flash"
  ) as Record<string, unknown>;
  assert.equal(flash.reasoning_effort, "low");

  const pro = sanitizeReasoningEffortForProvider(
    { model: "deepseek-v4-pro", reasoning_effort: "low" },
    "deepseek",
    "deepseek-v4-pro"
  ) as Record<string, unknown>;
  assert.equal(pro.reasoning_effort, "high");
});
