import type {
  HarnessSettings,
  ModelCapabilities,
  ServerProviderModel,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { Duration, Effect, Layer, Stream } from "effect";

import { discoverSkills } from "../../harness/skills/loader";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { HarnessProvider } from "../Services/HarnessProvider";
import { ServerSettingsService } from "../../serverSettings";
import { readHarnessProbe } from "./harnessRuntime";

const PROVIDER = "harness" as const;

const DEFAULT_HARNESS_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "anthropic/claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: DEFAULT_HARNESS_MODEL_CAPABILITIES,
  },
  {
    slug: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: DEFAULT_HARNESS_MODEL_CAPABILITIES,
  },
  {
    slug: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: DEFAULT_HARNESS_MODEL_CAPABILITIES,
  },
  {
    slug: "openai/gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: DEFAULT_HARNESS_MODEL_CAPABILITIES,
  },
  {
    slug: "openai/gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    isCustom: false,
    capabilities: DEFAULT_HARNESS_MODEL_CAPABILITIES,
  },
  {
    slug: "openai/gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    isCustom: false,
    capabilities: DEFAULT_HARNESS_MODEL_CAPABILITIES,
  },
  {
    slug: "openrouter/google/gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    isCustom: false,
    capabilities: DEFAULT_HARNESS_MODEL_CAPABILITIES,
  },
];

function haveHarnessSettingsChanged(previous: HarnessSettings, next: HarnessSettings): boolean {
  return (
    previous.enabled !== next.enabled ||
    previous.customModels.length !== next.customModels.length ||
    previous.customModels.some((value, index) => value !== next.customModels[index]) ||
    previous.enableBuiltinLsp !== next.enableBuiltinLsp ||
    JSON.stringify(previous.mcpServers) !== JSON.stringify(next.mcpServers) ||
    JSON.stringify(previous.lspServers) !== JSON.stringify(next.lspServers)
  );
}

const makeHarnessProvider = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;

  const getHarnessSettings = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.providers.harness),
  );

  const streamHarnessSettings = serverSettings.streamChanges.pipe(
    Stream.map((settings) => settings.providers.harness),
  );

  const checkProvider = Effect.gen(function* () {
    const harnessSettings = yield* getHarnessSettings;
    const cliSettings = yield* serverSettings.getSettings;
    const probe = yield* Effect.tryPromise(() =>
      readHarnessProbe(process.cwd(), {
        claudeBinaryPath: cliSettings.providers.claudeAgent.binaryPath,
        codexBinaryPath: cliSettings.providers.codex.binaryPath,
        codexHomePath: cliSettings.providers.codex.homePath,
      }),
    ).pipe(
      Effect.catch(() =>
        Effect.succeed({
          status: "error" as const,
          auth: {
            status: "unauthenticated" as const,
            type: "apiKey" as const,
          },
          message: "Unable to resolve harness provider configuration.",
        }),
      ),
    );
    const discoveredSkills = yield* Effect.tryPromise(() => discoverSkills(process.cwd())).pipe(
      Effect.catch(() => Effect.succeed([] as const)),
    );
    const skills: ReadonlyArray<ServerProviderSkill> = discoveredSkills.map((skill) =>
      skill.description
        ? {
            name: skill.name,
            path: skill.path,
            enabled: true,
            description: skill.description,
            displayName: skill.name,
            shortDescription: skill.description,
            scope: skill.source,
          }
        : {
            name: skill.name,
            path: skill.path,
            enabled: true,
            displayName: skill.name,
            scope: skill.source,
          },
    );
    return buildServerProvider({
      provider: PROVIDER,
      enabled: harnessSettings.enabled,
      checkedAt: new Date().toISOString(),
      models: providerModelsFromSettings(
        BUILT_IN_MODELS,
        PROVIDER,
        harnessSettings.customModels,
        DEFAULT_HARNESS_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: true,
        version: "local",
        ...probe,
      },
      skills,
    });
  });

  return yield* makeManagedServerProvider<HarnessSettings>({
    getSettings: getHarnessSettings.pipe(Effect.orDie),
    streamSettings: streamHarnessSettings,
    haveSettingsChanged: haveHarnessSettingsChanged,
    checkProvider,
    refreshInterval: Duration.minutes(1),
  });
});

export const HarnessProviderLive = Layer.effect(HarnessProvider, makeHarnessProvider);
