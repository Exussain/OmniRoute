import type { RegistryEntry } from "../../shared.ts";
import { buildOpenAiCompatibleRegistryEntry } from "../../shared.ts";

export const meganovaProvider: RegistryEntry = buildOpenAiCompatibleRegistryEntry({
  id: "meganova",
  alias: "meganova",
  baseUrl: "https://api.meganova.ai/v1/chat/completions",
  modelsUrl: "https://api.meganova.ai/v1/models",
  models: [],
  passthroughModels: true,
});
