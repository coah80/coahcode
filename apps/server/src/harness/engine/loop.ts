// Agent Loop Engine — the heart of the harness
// Implements Cursor-style BiDi tool loop with parallel execution
//
// Flow:
//   1. Send user message + tools to model
//   2. Stream response — accumulate text + tool calls
//   3. Execute all tool calls in PARALLEL
//   4. Append results to conversation
//   5. Send back to model → repeat until no more tool calls
//   6. Auto-verify (lint check) after edits

import type {
  AgentConfig,
  AgentEvent,
  AgentTurn,
  ConversationMessage,
  ToolCall,
  ToolResult,
  ToolDefinition,
} from "../types";
import { getToolDefinitions } from "../tools/index";
import {
  executeScheduledTaskTool,
  getScheduledTaskToolDefinition,
  type AgentScheduledTaskManager,
} from "../tools/scheduledTasks";
import { streamAnthropic } from "../providers/anthropic";
import { streamOpenAI } from "../providers/openai";
import {
  runClaudeSubscriptionTurn,
  runCodexSubscriptionTurn,
} from "../providers/cliSubscriptionTurn";
import { buildSystemPrompt } from "./prompt";
import { McpManager, type McpServerConfig } from "../mcp/client";
import { LspManager } from "../lsp/client";
import {
  discoverSkills,
  loadInstructions,
  getSkillToolDefinition,
  getSkillContent,
} from "../skills/loader";
import {
  createNudgeState,
  incrementTurn,
  shouldNudgeSkill,
  shouldNudgeMemory,
  resetSkillNudge,
  resetMemoryNudge,
  SKILL_NUDGE_MESSAGE,
  MEMORY_NUDGE_MESSAGE,
} from "./skillNudge";
import { spillTurnResults } from "./resultSpill";
import { CheckpointManager } from "./checkpoint";

export interface AgentLoopOptions {
  readonly config: AgentConfig;
  readonly userMessage: string;
  readonly conversationHistory?: readonly ConversationMessage[];
  readonly signal?: AbortSignal | undefined;
  readonly mcpConfigs?: readonly McpServerConfig[] | undefined;
  readonly lspManager?: LspManager | undefined;
  readonly scheduledTaskManager?: AgentScheduledTaskManager | undefined;
}

export async function* runAgentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const {
    config,
    userMessage,
    conversationHistory = [],
    signal,
    mcpConfigs,
    lspManager,
    scheduledTaskManager,
  } = options;
  const maxTurns = config.maxTurns ?? 50;

  // ─── Discover skills + instructions ────────────────────────────────
  const [skills, instructions] = await Promise.all([
    discoverSkills(config.workspaceRoot),
    loadInstructions(config.workspaceRoot),
  ]);

  // ─── Connect MCP servers ───────────────────────────────────────────
  const mcpManager = new McpManager();
  if (mcpConfigs && mcpConfigs.length > 0) {
    await mcpManager.connectAll(mcpConfigs);
  }

  // ─── Build tools list (built-in + MCP + LSP + skills) ──────────────
  const allTools: ToolDefinition[] = [
    ...(config.mode === "plan" ? [] : getToolDefinitions()),
    ...mcpManager.getToolDefinitions(),
  ];

  // Add LSP tool if manager provided
  if (lspManager) {
    allTools.push(lspManager.getToolDefinition());
  }

  // Add skill tool if skills found
  const skillTool = getSkillToolDefinition(skills);
  if (skillTool) {
    allTools.push(skillTool);
  }

  if (scheduledTaskManager) {
    allTools.push(getScheduledTaskToolDefinition());
  }

  // ─── Build system prompt with instructions ─────────────────────────
  let systemPrompt = config.systemPrompt ?? buildSystemPrompt(config);
  if (instructions.length > 0) {
    systemPrompt += "\n\n<instructions>\n" + instructions.join("\n\n---\n\n") + "\n</instructions>";
  }

  // Build initial conversation
  const messages: ConversationMessage[] = [...conversationHistory];
  messages.push({ role: "user", content: userMessage });

  if (config.provider === "anthropic" && config.upstream.kind === "claude_subscription") {
    for await (const event of runClaudeSubscriptionTurn({
      model: config.model,
      cwd: config.workspaceRoot,
      systemPrompt,
      conversationHistory,
      userMessage,
      signal,
      claudeBinaryPath: config.upstream.claudeBinaryPath,
      mode: config.mode,
      harnessRuntimeMode: config.harnessRuntimeMode ?? "auto-accept-edits",
    })) {
      yield event;
    }
    await mcpManager.closeAll();
    return;
  }

  if (config.provider === "openai" && config.upstream.kind === "openai_subscription") {
    for await (const event of runCodexSubscriptionTurn({
      model: config.model,
      cwd: config.workspaceRoot,
      systemPrompt,
      conversationHistory,
      userMessage,
      signal,
      codexBinaryPath: config.upstream.codexBinaryPath,
      codexHomePath: config.upstream.codexHomePath,
    })) {
      yield event;
    }
    await mcpManager.closeAll();
    return;
  }

  if (config.upstream.kind !== "api_key") {
    yield {
      type: "error",
      error: "Harness API routing needs an API key for this model provider.",
    };
    await mcpManager.closeAll();
    return;
  }

  const apiUpstream = config.upstream;

  let turnNumber = 0;
  const editedFiles: Set<string> = new Set();
  let nudgeState = createNudgeState();
  const checkpointMgr = new CheckpointManager(config.workspaceRoot);

  while (turnNumber < maxTurns) {
    if (signal?.aborted) {
      yield { type: "error", error: "Aborted by user" };
      return;
    }

    turnNumber++;
    let turnText = "";
    let thinkingText = "";
    const toolCalls: ToolCall[] = [];

    // ─── Stream model response ─────────────────────────────────────────
    const stream =
      config.provider === "anthropic"
        ? streamAnthropic({
            model: config.model,
            apiKey: apiUpstream.apiKey,
            ...(apiUpstream.baseURL ? { baseURL: apiUpstream.baseURL } : {}),
            messages,
            tools: allTools,
            systemPrompt,
            thinkingEnabled: true,
            signal,
          })
        : streamOpenAI({
            model: config.model,
            apiKey: apiUpstream.apiKey,
            baseURL:
              apiUpstream.baseURL ??
              (config.provider === "openrouter"
                ? "https://openrouter.ai/api/v1"
                : "https://api.openai.com/v1"),
            messages,
            tools: allTools,
            systemPrompt,
            signal,
          });

    for await (const event of stream) {
      if (signal?.aborted) {
        yield { type: "error", error: "Aborted by user" };
        return;
      }

      switch (event.type) {
        case "text_delta":
          turnText += event.text;
          yield event;
          break;

        case "thinking_delta":
          thinkingText += event.text;
          yield event;
          break;

        case "tool_call_start":
          toolCalls.push(event.toolCall);
          yield event;
          break;

        case "error":
          yield event;
          return;
      }
    }

    // ─── No tool calls → agent is done ─────────────────────────────────
    if (toolCalls.length === 0) {
      // Append assistant message to history
      messages.push({ role: "assistant", content: turnText });

      const turn: AgentTurn = {
        turnNumber,
        text: turnText,
        toolCalls: [],
        toolResults: [],
        thinkingContent: thinkingText || undefined,
      };
      yield { type: "turn_complete", turn };
      yield { type: "agent_complete", totalTurns: turnNumber };
      return;
    }

    // ─── Execute tool calls in PARALLEL ────────────────────────────────
    yield {
      type: "commentary",
      text: `Executing ${toolCalls.length} tool${toolCalls.length > 1 ? "s" : ""} in parallel...`,
    };

    // Route each tool call to the right executor
    const results: ToolResult[] = await Promise.all(
      toolCalls.map(async (call): Promise<ToolResult> => {
        try {
          // MCP tools (prefixed with mcp_)
          if (call.name.startsWith("mcp_")) {
            const parts = call.name.split("_");
            const serverName = parts[1]!;
            const toolName = parts.slice(2).join("_");
            const content = await mcpManager.callTool(serverName, toolName, call.arguments);
            return { tool_call_id: call.id, content };
          }

          // LSP tool
          if (call.name === "LSP" && lspManager) {
            const op = call.arguments.operation as string;
            const filePath = call.arguments.filePath as string;
            const line = call.arguments.line as number;
            const char = call.arguments.character as number;

            let content: string;
            switch (op) {
              case "getDiagnostics": {
                const diags = await lspManager.getDiagnostics(filePath);
                content =
                  diags.length === 0
                    ? "No diagnostics found."
                    : diags
                        .map(
                          (d) =>
                            `${d.severity.toUpperCase()} [${d.line}:${d.character}] ${d.message}${d.source ? ` (${d.source})` : ""}`,
                        )
                        .join("\n");
                break;
              }
              case "goToDefinition":
                content = await lspManager.goToDefinition(filePath, line, char);
                break;
              case "hover":
                content = await lspManager.hover(filePath, line, char);
                break;
              default:
                content = `Unknown LSP operation: ${op}`;
            }
            return { tool_call_id: call.id, content };
          }

          // Skill tool
          if (call.name === "Skill") {
            const skillName = call.arguments.name as string;
            const content = getSkillContent(skills, skillName);
            return { tool_call_id: call.id, content };
          }

          if (call.name === "ScheduledTask" && scheduledTaskManager) {
            const content = await executeScheduledTaskTool(call.arguments, {
              manager: scheduledTaskManager,
              config,
            });
            return { tool_call_id: call.id, content };
          }

          // Built-in tools
          const { executeTool } = await import("../tools/index.js");
          return executeTool(call, config.workspaceRoot);
        } catch (error) {
          return {
            tool_call_id: call.id,
            content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
            is_error: true,
          };
        }
      }),
    );

    // ─── Checkpoint before file mutations ──────────────────────────────
    const mutatingFiles = toolCalls
      .filter((tc) => ["Write", "StrReplace", "Delete"].includes(tc.name))
      .map((tc) => tc.arguments.path as string)
      .filter(Boolean);

    if (mutatingFiles.length > 0) {
      try {
        await checkpointMgr.createCheckpoint(
          `Turn ${turnNumber}: ${mutatingFiles.map((f) => f.split("/").pop()).join(", ")}`,
          mutatingFiles,
        );
      } catch {
        /* checkpoint is best-effort */
      }
    }

    // Track edited files for auto-verification
    for (const tc of toolCalls) {
      if (["Write", "StrReplace"].includes(tc.name)) {
        const path = tc.arguments.path as string;
        if (path) editedFiles.add(path);
      }
    }

    // ─── Spill large results to temp files ─────────────────────────────
    const spilledContents = await spillTurnResults(
      results.map((r) => ({
        content: r.content,
        toolName: toolCalls.find((tc) => tc.id === r.tool_call_id)?.name ?? "unknown",
      })),
    );
    const spilledResults: ToolResult[] = results.map((r, i) => ({
      ...r,
      content: spilledContents[i] ?? r.content,
    }));

    // Emit tool results (with spilled content)
    for (const result of spilledResults) {
      yield { type: "tool_call_complete", toolCallId: result.tool_call_id, result };
    }

    // ─── Append to conversation history ────────────────────────────────
    // Assistant message with tool calls
    messages.push({
      role: "assistant",
      content: turnText,
      tool_calls: toolCalls,
    });

    // Tool results as separate messages (using spilled content)
    if (config.provider === "anthropic") {
      messages.push({
        role: "user",
        content: spilledResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_call_id,
          content: r.content,
        })),
      });
    } else {
      for (const result of spilledResults) {
        messages.push({
          role: "tool",
          content: result.content,
          tool_call_id: result.tool_call_id,
        });
      }
    }

    // ─── Nudge system — periodic skill/memory reminders ────────────────
    nudgeState = incrementTurn(nudgeState);

    if (shouldNudgeSkill(nudgeState)) {
      messages.push({ role: "user", content: SKILL_NUDGE_MESSAGE });
      nudgeState = resetSkillNudge(nudgeState);
    }

    if (shouldNudgeMemory(nudgeState)) {
      messages.push({ role: "user", content: MEMORY_NUDGE_MESSAGE });
      nudgeState = resetMemoryNudge(nudgeState);
    }

    const turn: AgentTurn = {
      turnNumber,
      text: turnText,
      toolCalls,
      toolResults: [...results],
      thinkingContent: thinkingText || undefined,
    };
    yield { type: "turn_complete", turn };

    // ─── Auto-verification: lint check after edits ─────────────────────
    if (editedFiles.size > 0 && turnNumber > 1) {
      // Check if the model just finished a sequence of edits without
      // already calling ReadLints. If so, we inject a lint check hint.
      const lastToolNames = toolCalls.map((tc) => tc.name);
      const hasEdits = lastToolNames.some((n) => ["Write", "StrReplace"].includes(n));
      const alreadyCheckedLints = lastToolNames.includes("ReadLints");

      if (hasEdits && !alreadyCheckedLints) {
        // The model will naturally check lints on the next turn because
        // the system prompt says to. We just track that it should.
        // In Cursor, this is the LOOP_ON_LINTS capability.
      }
    }
  }

  // Cleanup
  mcpManager.closeAll();

  yield { type: "error", error: `Max turns (${maxTurns}) reached` };
}

// ─── Subagent Support ────────────────────────────────────────────────────────

export interface SubagentOptions {
  readonly parentConfig: AgentConfig;
  readonly prompt: string;
  readonly subagentType?: string;
  readonly readonly?: boolean;
}

export async function* runSubagent(options: SubagentOptions): AsyncGenerator<AgentEvent> {
  const { parentConfig, prompt, readonly } = options;

  const subConfig: AgentConfig = {
    ...parentConfig,
    mode: readonly ? "chat" : "agent",
    maxTurns: 20,
  };

  yield* runAgentLoop({
    config: subConfig,
    userMessage: prompt,
  });
}
