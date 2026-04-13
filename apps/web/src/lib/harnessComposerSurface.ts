import type { ProviderKind } from "@t3tools/contracts";

export type HarnessSurfaceProvider = Extract<ProviderKind, "codex" | "claudeAgent">;

export function harnessModelToSurface(model: string | null | undefined): {
  surfaceProvider: HarnessSurfaceProvider;
  surfaceModel: string;
} {
  const m = (model ?? "").trim();
  if (m.startsWith("openai/")) {
    return { surfaceProvider: "codex", surfaceModel: m.slice("openai/".length) };
  }
  if (m.startsWith("anthropic/")) {
    return { surfaceProvider: "claudeAgent", surfaceModel: m.slice("anthropic/".length) };
  }
  return { surfaceProvider: "claudeAgent", surfaceModel: m };
}

export function surfaceModelToHarness(surface: HarnessSurfaceProvider, model: string): string {
  const trimmed = model.trim();
  if (trimmed.includes("/")) {
    return trimmed;
  }
  return surface === "codex" ? `openai/${trimmed}` : `anthropic/${trimmed}`;
}
