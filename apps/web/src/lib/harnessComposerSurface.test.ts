import { describe, expect, it } from "vitest";
import { harnessModelToSurface, surfaceModelToHarness } from "./harnessComposerSurface";

describe("harnessComposerSurface", () => {
  it("maps anthropic prefix to Claude surface", () => {
    expect(harnessModelToSurface("anthropic/claude-opus-4-6")).toEqual({
      surfaceProvider: "claudeAgent",
      surfaceModel: "claude-opus-4-6",
    });
  });

  it("maps openai prefix to Codex surface", () => {
    expect(harnessModelToSurface("openai/gpt-5.4")).toEqual({
      surfaceProvider: "codex",
      surfaceModel: "gpt-5.4",
    });
  });

  it("adds anthropic prefix from Claude surface", () => {
    expect(surfaceModelToHarness("claudeAgent", "claude-opus-4-6")).toBe(
      "anthropic/claude-opus-4-6",
    );
  });

  it("adds openai prefix from Codex surface", () => {
    expect(surfaceModelToHarness("codex", "gpt-5.4")).toBe("openai/gpt-5.4");
  });

  it("preserves already-prefixed slugs", () => {
    expect(surfaceModelToHarness("codex", "openai/gpt-5.4")).toBe("openai/gpt-5.4");
  });
});
