import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentEvent, ConversationMessage } from "../types.ts";

const HARNESS_SUBSCRIPTION_TURN_TIMEOUT_MS = 900_000;

function flattenMessageContent(content: ConversationMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "tool_result") {
        return `[tool_result ${block.tool_use_id}] ${block.content}`;
      }
      return JSON.stringify(block);
    })
    .join("\n");
}

function formatConversationForCli(
  systemPrompt: string,
  history: readonly ConversationMessage[],
  userMessage: string,
): string {
  const parts: string[] = [`${systemPrompt.trim()}\n`];
  if (history.length > 0) {
    parts.push("<conversation_history>\n");
    for (const m of history) {
      const body = flattenMessageContent(m.content);
      if (m.role === "tool") {
        parts.push(`[tool ${m.tool_call_id ?? "?"}]\n${body}\n`);
      } else if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        parts.push(
          `[assistant + ${m.tool_calls.length} tool_calls]\n${body}\n${m.tool_calls.map((t) => `- ${t.name}(${t.id})`).join("\n")}\n`,
        );
      } else {
        parts.push(`${m.role.toUpperCase()}:\n${body}\n`);
      }
    }
    parts.push("</conversation_history>\n");
  }
  parts.push(`USER:\n${userMessage.trim()}`);
  return parts.join("\n");
}

async function* singleUserPrompt(composed: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text: composed }],
    },
  } as SDKUserMessage;
}

export async function* runClaudeSubscriptionTurn(input: {
  readonly model: string;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly conversationHistory: readonly ConversationMessage[];
  readonly userMessage: string;
  readonly signal?: AbortSignal | undefined;
  readonly claudeBinaryPath?: string | undefined;
  readonly mode: "agent" | "chat" | "plan" | "debug";
  readonly harnessRuntimeMode: "full-access" | "auto-accept-edits";
}): AsyncGenerator<AgentEvent> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
  }, HARNESS_SUBSCRIPTION_TURN_TIMEOUT_MS);
  const effectiveSignal = input.signal
    ? AbortSignal.any([input.signal, timeoutController.signal])
    : timeoutController.signal;

  const composed = formatConversationForCli(
    input.systemPrompt,
    input.conversationHistory,
    input.userMessage,
  );

  let permissionMode: PermissionMode;
  let allowDangerouslySkipPermissions: boolean | undefined;
  if (input.mode === "plan") {
    permissionMode = "plan";
  } else if (input.mode === "chat") {
    permissionMode = "default";
  } else if (input.harnessRuntimeMode === "full-access") {
    permissionMode = "bypassPermissions";
    allowDangerouslySkipPermissions = true;
  } else {
    permissionMode = "acceptEdits";
  }

  const options: ClaudeQueryOptions = {
    cwd: input.cwd,
    model: input.model,
    permissionMode,
    ...(allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
    env: process.env,
    ...(input.claudeBinaryPath ? { pathToClaudeCodeExecutable: input.claudeBinaryPath } : {}),
    includePartialMessages: true,
  };

  const q = query({ prompt: singleUserPrompt(composed), options });

  const abortListener = () => {
    try {
      q.close();
    } catch {
      /* ignore */
    }
  };
  if (effectiveSignal.aborted) {
    clearTimeout(timeoutId);
    yield {
      type: "error",
      error: input.signal?.aborted
        ? "Aborted by user"
        : `Claude harness turn exceeded ${HARNESS_SUBSCRIPTION_TURN_TIMEOUT_MS / 1000}s`,
    };
    return;
  }
  effectiveSignal.addEventListener("abort", abortListener, { once: true });

  let totalText = "";
  let thinking = "";

  try {
    for await (const msg of q) {
      if (effectiveSignal.aborted) {
        clearTimeout(timeoutId);
        yield {
          type: "error",
          error: input.signal?.aborted
            ? "Aborted by user"
            : `Claude harness turn exceeded ${HARNESS_SUBSCRIPTION_TURN_TIMEOUT_MS / 1000}s`,
        };
        return;
      }

      if (msg.type === "stream_event") {
        const ev = msg.event as {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          totalText += ev.delta.text;
          yield { type: "text_delta", text: ev.delta.text };
        } else if (
          ev.type === "content_block_delta" &&
          ev.delta?.type === "thinking_delta" &&
          typeof ev.delta.thinking === "string" &&
          ev.delta.thinking.length > 0
        ) {
          thinking += ev.delta.thinking;
          yield { type: "thinking_delta", text: ev.delta.thinking };
        }
        continue;
      }

      if (msg.type === "result") {
        const r = msg as {
          subtype?: string;
          is_error?: boolean;
          errors?: readonly string[];
          result?: string;
        };
        if (r.subtype !== "success" || r.is_error) {
          const detail =
            r.errors && r.errors.length > 0 ? r.errors.join("; ") : "Claude Code run failed.";
          yield { type: "error", error: detail };
          return;
        }
        if (
          typeof r.result === "string" &&
          r.result.trim().length > 0 &&
          totalText.trim().length === 0
        ) {
          totalText = r.result;
          yield { type: "text_delta", text: r.result };
        }
        break;
      }
    }

    if (effectiveSignal.aborted) {
      clearTimeout(timeoutId);
      yield {
        type: "error",
        error: input.signal?.aborted
          ? "Aborted by user"
          : `Claude harness turn exceeded ${HARNESS_SUBSCRIPTION_TURN_TIMEOUT_MS / 1000}s`,
      };
      return;
    }

    yield {
      type: "turn_complete",
      turn: {
        turnNumber: 1,
        text: totalText,
        toolCalls: [],
        toolResults: [],
        ...(thinking.trim().length > 0 ? { thinkingContent: thinking } : {}),
      },
    };
    yield { type: "agent_complete", totalTurns: 1 };
  } finally {
    clearTimeout(timeoutId);
    effectiveSignal.removeEventListener("abort", abortListener);
    try {
      q.close();
    } catch {
      /* ignore */
    }
  }
}

export async function* runCodexSubscriptionTurn(input: {
  readonly model: string;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly conversationHistory: readonly ConversationMessage[];
  readonly userMessage: string;
  readonly signal?: AbortSignal | undefined;
  readonly codexBinaryPath?: string | undefined;
  readonly codexHomePath?: string | undefined;
}): AsyncGenerator<AgentEvent> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
  }, HARNESS_SUBSCRIPTION_TURN_TIMEOUT_MS);
  const effectiveSignal = input.signal
    ? AbortSignal.any([input.signal, timeoutController.signal])
    : timeoutController.signal;

  if (effectiveSignal.aborted) {
    clearTimeout(timeoutId);
    yield {
      type: "error",
      error: input.signal?.aborted
        ? "Aborted by user"
        : `Codex harness turn exceeded ${HARNESS_SUBSCRIPTION_TURN_TIMEOUT_MS / 1000}s`,
    };
    return;
  }

  const bin = input.codexBinaryPath?.trim() || "codex";
  const prompt = formatConversationForCli(
    input.systemPrompt,
    input.conversationHistory,
    input.userMessage,
  );

  const env =
    input.codexHomePath && input.codexHomePath.trim().length > 0
      ? { ...process.env, CODEX_HOME: input.codexHomePath.trim() }
      : process.env;

  const child = spawn(
    bin,
    [
      "exec",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-m",
      input.model,
      "-C",
      input.cwd,
      "-",
    ],
    {
      cwd: input.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    },
  );

  const abortListener = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  effectiveSignal.addEventListener("abort", abortListener, { once: true });

  child.stdin.write(prompt);
  child.stdin.end();

  let stdout = "";
  let stderr = "";

  try {
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      for await (const chunk of child.stdout) {
        if (effectiveSignal.aborted) {
          clearTimeout(timeoutId);
          yield {
            type: "error",
            error: input.signal?.aborted
              ? "Aborted by user"
              : `Codex harness turn exceeded ${HARNESS_SUBSCRIPTION_TURN_TIMEOUT_MS / 1000}s`,
          };
          return;
        }
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stdout += text;
        if (text.length > 0) {
          yield { type: "text_delta", text };
        }
      }
    }
    if (effectiveSignal.aborted) {
      clearTimeout(timeoutId);
      yield {
        type: "error",
        error: input.signal?.aborted
          ? "Aborted by user"
          : `Codex harness turn exceeded ${HARNESS_SUBSCRIPTION_TURN_TIMEOUT_MS / 1000}s`,
      };
      return;
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      for await (const chunk of child.stderr) {
        if (effectiveSignal.aborted) {
          clearTimeout(timeoutId);
          yield {
            type: "error",
            error: input.signal?.aborted
              ? "Aborted by user"
              : `Codex harness turn exceeded ${HARNESS_SUBSCRIPTION_TURN_TIMEOUT_MS / 1000}s`,
          };
          return;
        }
        stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      }
    }

    const [code] = (await once(child, "close")) as [number | null];
    if (effectiveSignal.aborted) {
      clearTimeout(timeoutId);
      yield {
        type: "error",
        error: input.signal?.aborted
          ? "Aborted by user"
          : `Codex harness turn exceeded ${HARNESS_SUBSCRIPTION_TURN_TIMEOUT_MS / 1000}s`,
      };
      return;
    }
    if (code !== 0) {
      const detail = stderr.trim() || stdout.trim() || `Codex exec exited with code ${code}`;
      yield { type: "error", error: detail };
      return;
    }

    yield {
      type: "turn_complete",
      turn: {
        turnNumber: 1,
        text: stdout,
        toolCalls: [],
        toolResults: [],
      },
    };
    yield { type: "agent_complete", totalTurns: 1 };
  } finally {
    clearTimeout(timeoutId);
    effectiveSignal.removeEventListener("abort", abortListener);
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}
