import assert from "node:assert";
import { afterEach, describe, it } from "vitest";

import {
  isClaudeSubscriptionOAuthTokenConfigured,
  probeClaudeSubscriptionAuth,
} from "./cliAuthProbe.ts";

describe("cliAuthProbe", () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it("isClaudeSubscriptionOAuthTokenConfigured is false when unset", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    assert.strictEqual(isClaudeSubscriptionOAuthTokenConfigured(), false);
  });

  it("isClaudeSubscriptionOAuthTokenConfigured is false for whitespace", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "   \n\t  ";
    assert.strictEqual(isClaudeSubscriptionOAuthTokenConfigured(), false);
  });

  it("isClaudeSubscriptionOAuthTokenConfigured is true when token non-empty", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    assert.strictEqual(isClaudeSubscriptionOAuthTokenConfigured(), true);
  });

  it("probeClaudeSubscriptionAuth resolves true when OAuth token env is set", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    assert.strictEqual(await probeClaudeSubscriptionAuth(), true);
  });
});
