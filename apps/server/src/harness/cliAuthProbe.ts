import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CommandResult } from "../provider/providerSnapshot.ts";
import { parseClaudeAuthStatusFromOutput } from "../provider/Layers/ClaudeProvider.ts";
import { parseAuthStatusFromOutput } from "../provider/Layers/CodexProvider.ts";

const execFileAsync = promisify(execFile);

export function isClaudeSubscriptionOAuthTokenConfigured(): boolean {
  const raw = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof raw !== "string") {
    return false;
  }
  return raw.trim().length > 0;
}

async function execFileResult(
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  try {
    const r = await execFileAsync(file, [...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 12_000,
      ...(env ? { env } : {}),
    });
    return {
      stdout: String(r.stdout ?? ""),
      stderr: String(r.stderr ?? ""),
      code: 0,
    };
  } catch (cause: unknown) {
    const err = cause as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number;
    };
    return {
      stdout: err.stdout !== undefined ? String(err.stdout) : "",
      stderr: err.stderr !== undefined ? String(err.stderr) : "",
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

export async function probeClaudeSubscriptionAuth(binaryPath?: string): Promise<boolean> {
  if (isClaudeSubscriptionOAuthTokenConfigured()) {
    return true;
  }
  const bin = binaryPath?.trim() || "claude";
  const result = await execFileResult(bin, ["auth", "status"]);
  const parsed = parseClaudeAuthStatusFromOutput(result);
  return parsed.status === "ready" && parsed.auth.status === "authenticated";
}

export async function probeCodexSubscriptionAuth(
  binaryPath?: string,
  homePath?: string,
): Promise<boolean> {
  const bin = binaryPath?.trim() || "codex";
  const env =
    homePath && homePath.trim().length > 0
      ? { ...process.env, CODEX_HOME: homePath.trim() }
      : process.env;
  const result = await execFileResult(bin, ["login", "status"], env);
  const parsed = parseAuthStatusFromOutput(result);
  return parsed.status === "ready" && parsed.auth.status === "authenticated";
}
