import {
  DEFAULT_MODEL_BY_PROVIDER,
  type HarnessLspServerSettings,
  type HarnessMcpServerSettings,
  type ModelSelection,
  type ProviderKind,
} from "@t3tools/contracts";

import type { HarnessUpstreamCredentials } from "../../harness/types.ts";
import {
  isClaudeSubscriptionOAuthTokenConfigured,
  probeClaudeSubscriptionAuth,
  probeCodexSubscriptionAuth,
} from "../../harness/cliAuthProbe.ts";
import { LspManager } from "../../harness/lsp/client.ts";
import type { McpServerConfig } from "../../harness/mcp/client.ts";
import {
  loadOpencodeInterop,
  type OpencodeInteropProvider,
} from "../../harness/opencodeInterop.ts";

export type HarnessUpstreamProvider = "anthropic" | "openai" | "openrouter";

export type HarnessUpstreamAuth = HarnessUpstreamCredentials;

export function parseHarnessModel(model: string): {
  readonly upstream: HarnessUpstreamProvider;
  readonly model: string;
} {
  const trimmed = model.trim();
  if (trimmed.startsWith("anthropic/")) {
    return { upstream: "anthropic", model: trimmed.slice("anthropic/".length) };
  }
  if (trimmed.startsWith("openai/")) {
    return { upstream: "openai", model: trimmed.slice("openai/".length) };
  }
  if (trimmed.startsWith("openrouter/")) {
    return { upstream: "openrouter", model: trimmed.slice("openrouter/".length) };
  }
  if (trimmed.startsWith("claude-")) {
    return { upstream: "anthropic", model: trimmed };
  }
  if (trimmed.startsWith("gpt-")) {
    return { upstream: "openai", model: trimmed };
  }
  return { upstream: "openrouter", model: trimmed };
}

export type RoutableHarnessSourceProvider = Extract<ProviderKind, "codex" | "claudeAgent">;

export function harnessUpstreamForRoutable(
  source: RoutableHarnessSourceProvider,
): HarnessUpstreamProvider {
  return source === "codex" ? "openai" : "anthropic";
}

export function harnessModelFromRoutableSource(
  source: RoutableHarnessSourceProvider,
  model: string,
): string {
  const trimmed = model.trim();
  if (trimmed.includes("/")) {
    return trimmed;
  }
  return `${harnessUpstreamForRoutable(source)}/${trimmed}`;
}

export function coerceModelSelectionToHarness(
  modelSelection: ModelSelection,
): Extract<ModelSelection, { provider: "harness" }> | undefined {
  if (modelSelection.provider === "harness") {
    return {
      provider: "harness",
      model: modelSelection.model.trim(),
    };
  }
  if (modelSelection.provider === "codex" || modelSelection.provider === "claudeAgent") {
    const source = modelSelection.provider;
    return {
      provider: "harness",
      model: harnessModelFromRoutableSource(
        source,
        modelSelection.model?.trim() || DEFAULT_MODEL_BY_PROVIDER[source],
      ),
    };
  }
  return undefined;
}

export function routableSessionModelSelectionToHarness(
  routedProvider: RoutableHarnessSourceProvider,
  selection: ModelSelection | undefined,
): { provider: "harness"; model: string } {
  if (selection?.provider === "harness") {
    return { provider: "harness", model: selection.model.trim() };
  }
  const source: RoutableHarnessSourceProvider =
    selection?.provider === "codex" || selection?.provider === "claudeAgent"
      ? selection.provider
      : routedProvider;
  return {
    provider: "harness",
    model: harnessModelFromRoutableSource(
      source,
      selection?.model?.trim() || DEFAULT_MODEL_BY_PROVIDER[source],
    ),
  };
}

export function stripRoutableHarnessModelPrefix(
  routedProvider: RoutableHarnessSourceProvider,
  model: string | undefined,
): string | undefined {
  if (!model) {
    return model;
  }
  const prefix = `${harnessUpstreamForRoutable(routedProvider)}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readHarnessEnvApiKey(upstream: HarnessUpstreamProvider): string | undefined {
  switch (upstream) {
    case "anthropic":
      return trimOrUndefined(process.env.ANTHROPIC_API_KEY);
    case "openai":
      return trimOrUndefined(process.env.OPENAI_API_KEY);
    case "openrouter":
      return trimOrUndefined(process.env.OPENROUTER_API_KEY);
  }
}

export function toHarnessMcpConfigs(
  servers: ReadonlyArray<HarnessMcpServerSettings>,
): ReadonlyArray<McpServerConfig> {
  const configs: McpServerConfig[] = [];

  for (const server of servers) {
    if (server.type === "local") {
      if (!server.command || server.command.length === 0) {
        continue;
      }
      configs.push({
        name: server.name,
        type: "local",
        command: server.command,
        ...(server.environment ? { environment: server.environment } : {}),
        enabled: server.enabled,
        ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
      });
      continue;
    }

    if (!server.url || server.url.length === 0) {
      continue;
    }

    configs.push({
      name: server.name,
      type: "remote",
      url: server.url,
      ...(server.environment ? { environment: server.environment } : {}),
      enabled: server.enabled,
      ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
    });
  }

  return configs;
}

async function loadHarnessInterop(workspaceRoot: string) {
  return loadOpencodeInterop(workspaceRoot).catch(() => ({
    mcpServers: [] as ReadonlyArray<McpServerConfig>,
    skillDirectories: [] as ReadonlyArray<string>,
    instructionPatterns: [] as ReadonlyArray<never>,
    providerOptions: {} as Partial<
      Record<OpencodeInteropProvider, { apiKey?: string; baseURL?: string }>
    >,
  }));
}

export async function resolveHarnessUpstreamAuth(options: {
  readonly workspaceRoot: string;
  readonly upstream: HarnessUpstreamProvider;
  readonly claudeBinaryPath?: string;
  readonly codexBinaryPath?: string;
  readonly codexHomePath?: string;
}): Promise<HarnessUpstreamAuth | undefined> {
  const interop = await loadHarnessInterop(options.workspaceRoot);
  const imported = interop.providerOptions[options.upstream];
  const apiKey = trimOrUndefined(imported?.apiKey) ?? readHarnessEnvApiKey(options.upstream);
  if (apiKey) {
    const baseURL = trimOrUndefined(imported?.baseURL);
    return baseURL ? { kind: "api_key", apiKey, baseURL } : { kind: "api_key", apiKey };
  }

  if (options.upstream === "anthropic") {
    const ok = await probeClaudeSubscriptionAuth(options.claudeBinaryPath);
    if (!ok) {
      return undefined;
    }
    const trimmedClaude = trimOrUndefined(options.claudeBinaryPath);
    return trimmedClaude
      ? { kind: "claude_subscription", claudeBinaryPath: trimmedClaude }
      : { kind: "claude_subscription" };
  }

  if (options.upstream === "openai") {
    const ok = await probeCodexSubscriptionAuth(options.codexBinaryPath, options.codexHomePath);
    if (!ok) {
      return undefined;
    }
    const trimmedCodexBin = trimOrUndefined(options.codexBinaryPath);
    const trimmedCodexHome = trimOrUndefined(options.codexHomePath);
    if (trimmedCodexBin && trimmedCodexHome) {
      return {
        kind: "openai_subscription",
        codexBinaryPath: trimmedCodexBin,
        codexHomePath: trimmedCodexHome,
      };
    }
    if (trimmedCodexBin) {
      return { kind: "openai_subscription", codexBinaryPath: trimmedCodexBin };
    }
    if (trimmedCodexHome) {
      return { kind: "openai_subscription", codexHomePath: trimmedCodexHome };
    }
    return { kind: "openai_subscription" };
  }

  return undefined;
}

export async function resolveHarnessMcpConfigs(options: {
  readonly workspaceRoot: string;
  readonly servers: ReadonlyArray<HarnessMcpServerSettings>;
}): Promise<ReadonlyArray<McpServerConfig>> {
  const interop = await loadHarnessInterop(options.workspaceRoot);
  const merged = new Map<string, McpServerConfig>();

  for (const config of interop.mcpServers) {
    merged.set(config.name, config);
  }

  for (const config of toHarnessMcpConfigs(options.servers)) {
    merged.set(config.name, config);
  }

  return [...merged.values()];
}

export async function readHarnessProbe(
  workspaceRoot: string,
  cliPaths?: {
    readonly claudeBinaryPath?: string;
    readonly codexBinaryPath?: string;
    readonly codexHomePath?: string;
  },
): Promise<{
  readonly status: "ready" | "warning" | "error";
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated";
    readonly type: "apiKey" | "subscription" | "mixed";
    readonly label?: string | undefined;
  };
  readonly message?: string;
}> {
  const interop = await loadHarnessInterop(workspaceRoot);
  const available: string[] = [];
  const importedLabels: string[] = [];
  let sawApiKey = false;
  let sawSubscription = false;

  for (const upstream of ["anthropic", "openai", "openrouter"] as const) {
    const imported = interop.providerOptions[upstream];
    const apiKey = trimOrUndefined(imported?.apiKey) ?? readHarnessEnvApiKey(upstream);
    if (apiKey) {
      sawApiKey = true;
      const label =
        upstream === "anthropic"
          ? "Anthropic API"
          : upstream === "openai"
            ? "OpenAI API"
            : "OpenRouter";
      available.push(label);
      if (trimOrUndefined(imported?.baseURL) || trimOrUndefined(imported?.apiKey)) {
        importedLabels.push(label);
      }
      continue;
    }

    if (upstream === "anthropic") {
      const ok = await probeClaudeSubscriptionAuth(cliPaths?.claudeBinaryPath);
      if (ok) {
        sawSubscription = true;
        available.push(
          isClaudeSubscriptionOAuthTokenConfigured()
            ? "Claude subscription (CLAUDE_CODE_OAUTH_TOKEN)"
            : "Claude subscription (CLI)",
        );
      }
      continue;
    }

    if (upstream === "openai") {
      const ok = await probeCodexSubscriptionAuth(
        cliPaths?.codexBinaryPath,
        cliPaths?.codexHomePath,
      );
      if (ok) {
        sawSubscription = true;
        available.push("Codex / ChatGPT subscription (CLI)");
      }
    }
  }

  if (available.length === 0) {
    return {
      status: "error",
      auth: {
        status: "unauthenticated",
        type: "apiKey",
      },
      message:
        "Add ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY (or OpenCode provider keys), or use Claude / Codex subscriptions: run `claude` and sign in, or `claude setup-token` then set CLAUDE_CODE_OAUTH_TOKEN on the server process; run `codex login` for ChatGPT-backed Codex. Unset ANTHROPIC_API_KEY when you want the Claude subscription path instead of API keys.",
    };
  }

  const importedMessage =
    importedLabels.length > 0 ? ` Imported OpenCode config for ${importedLabels.join(", ")}.` : "";

  const authType = sawApiKey && sawSubscription ? "mixed" : sawApiKey ? "apiKey" : "subscription";

  return {
    status: "ready",
    auth: {
      status: "authenticated",
      type: authType,
      label: available.join(", "),
    },
    message: `Harness auth: ${available.join(", ")}.${importedMessage}`,
  };
}

export function createHarnessLspManager(options: {
  readonly enableBuiltinLsp: boolean;
  readonly lspServers: ReadonlyArray<HarnessLspServerSettings>;
}): LspManager | undefined {
  if (!options.enableBuiltinLsp && options.lspServers.length === 0) {
    return undefined;
  }

  const manager = new LspManager({ includeBuiltinServers: options.enableBuiltinLsp });
  for (const server of options.lspServers) {
    if (server.command.length === 0 || server.extensions.length === 0) {
      continue;
    }
    manager.addServer({
      id: server.id,
      command: server.command,
      extensions: server.extensions,
      ...(server.rootMarkers.length > 0 ? { rootMarkers: server.rootMarkers } : {}),
    });
  }

  return manager;
}
