// Agent harness type definitions — modeled after Cursor's architecture

export type ToolName =
  | "Shell"
  | "Read"
  | "Write"
  | "StrReplace"
  | "Delete"
  | "Glob"
  | "Grep"
  | "ReadLints"
  | "WebSearch"
  | "WebFetch"
  | "TodoWrite"
  | "ScheduledTask"
  | "AskQuestion"
  | "SwitchMode"
  | "Task"
  | "Await"
  | "GenerateImage"
  | "LSP"
  | "Skill";

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: ToolName;
  readonly arguments: Record<string, unknown>;
}

export interface ToolResult {
  readonly tool_call_id: string;
  readonly content: string;
  readonly is_error?: boolean | undefined;
}

export type AgentMode = "agent" | "chat" | "plan" | "debug";

export type HarnessUpstreamCredentials =
  | { readonly kind: "api_key"; readonly apiKey: string; readonly baseURL?: string }
  | { readonly kind: "claude_subscription"; readonly claudeBinaryPath?: string }
  | {
      readonly kind: "openai_subscription";
      readonly codexBinaryPath?: string;
      readonly codexHomePath?: string;
    };

export interface AgentConfig {
  readonly model: string;
  readonly provider: "anthropic" | "openai" | "openrouter";
  readonly upstream: HarnessUpstreamCredentials;
  readonly mode: AgentMode;
  readonly harnessRuntimeMode?: "full-access" | "auto-accept-edits";
  readonly workspaceRoot: string;
  readonly systemPrompt?: string | undefined;
  readonly maxTurns?: number | undefined;
  readonly enableYolo?: boolean | undefined;
  readonly yoloAllowlist?: readonly string[] | undefined;
}

export interface AgentTurn {
  readonly turnNumber: number;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly toolResults: readonly ToolResult[];
  readonly thinkingContent?: string | undefined;
}

export type AgentEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly toolCall: ToolCall }
  | {
      readonly type: "tool_call_complete";
      readonly toolCallId: string;
      readonly result: ToolResult;
    }
  | { readonly type: "turn_complete"; readonly turn: AgentTurn }
  | { readonly type: "agent_complete"; readonly totalTurns: number }
  | { readonly type: "error"; readonly error: string }
  | { readonly type: "commentary"; readonly text: string };

export interface ConversationMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | readonly ContentBlock[];
  readonly tool_calls?: readonly ToolCall[] | undefined;
  readonly tool_call_id?: string | undefined;
}

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string };

// Home environment types
export interface WorkspaceInfo {
  readonly path: string;
  readonly name: string;
  readonly isHome: boolean;
  readonly gitRemote?: string | undefined;
  readonly lastAccessed?: number | undefined;
}

// Scheduled task types
export interface ScheduledTask {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cronExpression: string;
  readonly workspacePath: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly lastRun?: number | undefined;
  readonly nextRun?: number | undefined;
  readonly lastResult?: string | undefined;
}

export interface Todo {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
}
