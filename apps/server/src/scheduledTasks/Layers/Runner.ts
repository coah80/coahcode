import { Data, Effect } from "effect";

import { runAgentLoop } from "../../harness/engine/loop.ts";
import { getNextRunTime } from "../../harness/engine/scheduler.ts";
import {
  createHarnessLspManager,
  parseHarnessModel,
  resolveHarnessMcpConfigs,
  resolveHarnessUpstreamAuth,
} from "../../provider/Layers/harnessRuntime.ts";
import { ServerSettingsService } from "../../serverSettings";
import { ScheduledTasksService } from "../Services/ScheduledTasks";

const SCHEDULED_TASK_POLL_INTERVAL_MS = 30_000;

class ScheduledTaskRunnerError extends Data.TaggedError("ScheduledTaskRunnerError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export const startScheduledTaskRunner = Effect.acquireRelease(
  Effect.gen(function* () {
    const scheduledTasks = yield* ScheduledTasksService;
    const serverSettings = yield* ServerSettingsService;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const runningTaskIds = new Set<string>();

    const executeTask = (task: {
      readonly id: string;
      readonly name: string;
      readonly prompt: string;
      readonly workspacePath: string;
      readonly model: string;
    }) => {
      const runState = { shouldMark: false };
      return Effect.gen(function* () {
        if (runningTaskIds.has(task.id)) {
          return;
        }
        runningTaskIds.add(task.id);

        yield* Effect.gen(function* () {
          const unifiedSettings = yield* serverSettings.getSettings;
          const harnessSettings = unifiedSettings.providers.harness;
          const parsedModel = parseHarnessModel(task.model);
          const upstreamAuth = yield* Effect.tryPromise(() =>
            resolveHarnessUpstreamAuth({
              workspaceRoot: task.workspacePath,
              upstream: parsedModel.upstream,
              claudeBinaryPath: unifiedSettings.providers.claudeAgent.binaryPath,
              codexBinaryPath: unifiedSettings.providers.codex.binaryPath,
              codexHomePath: unifiedSettings.providers.codex.homePath,
            }),
          );

          if (!upstreamAuth) {
            yield* Effect.logWarning("scheduled task skipped because upstream auth is missing", {
              taskId: task.id,
              name: task.name,
              upstream: parsedModel.upstream,
            });
            return;
          }

          runState.shouldMark = true;

          const mcpConfigs = yield* Effect.tryPromise(() =>
            resolveHarnessMcpConfigs({
              workspaceRoot: task.workspacePath,
              servers: harnessSettings.mcpServers,
            }),
          );
          const lspManager = createHarnessLspManager(harnessSettings);
          let assistantText = "";
          let taskError: string | null = null;

          yield* Effect.acquireUseRelease(
            Effect.succeed(lspManager),
            (managedLspManager) =>
              Effect.tryPromise({
                try: async () => {
                  for await (const event of runAgentLoop({
                    config: {
                      model: parsedModel.model,
                      provider: parsedModel.upstream,
                      upstream: upstreamAuth,
                      mode: "agent",
                      harnessRuntimeMode: "auto-accept-edits",
                      workspaceRoot: task.workspacePath,
                    },
                    userMessage: task.prompt,
                    ...(mcpConfigs.length > 0 ? { mcpConfigs } : {}),
                    ...(managedLspManager ? { lspManager: managedLspManager } : {}),
                  })) {
                    if (event.type === "text_delta") {
                      assistantText += event.text;
                    } else if (event.type === "error") {
                      taskError = event.error;
                    }
                  }
                },
                catch: (cause) =>
                  new ScheduledTaskRunnerError({
                    detail: "Scheduled task execution failed.",
                    cause,
                  }),
              }),
            (managedLspManager) =>
              Effect.promise(() => managedLspManager?.closeAll() ?? Promise.resolve()),
          );

          if (taskError) {
            yield* Effect.logError("scheduled task execution failed", {
              taskId: task.id,
              name: task.name,
              error: taskError,
            });
            return;
          }

          yield* Effect.logInfo("scheduled task execution completed", {
            taskId: task.id,
            name: task.name,
            responsePreview:
              assistantText.trim().length > 0 ? assistantText.trim().slice(0, 500) : undefined,
          });
        }).pipe(
          Effect.catch((cause) =>
            Effect.logError("scheduled task runner failed", {
              taskId: task.id,
              name: task.name,
              cause,
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              runningTaskIds.delete(task.id);
            }).pipe(
              Effect.andThen(() =>
                runState.shouldMark
                  ? scheduledTasks
                      .markRun(task.id, Date.now())
                      .pipe(Effect.asVoid, Effect.ignore({ log: true }))
                  : Effect.void,
              ),
            ),
          ),
        );
      });
    };

    const scanTasks = Effect.gen(function* () {
      const tasks = yield* scheduledTasks.list;
      const now = Date.now();

      for (const task of tasks) {
        if (!task.enabled || runningTaskIds.has(task.id)) {
          continue;
        }

        const baseline = task.lastRun ?? task.createdAt ?? now;
        const nextRunAt = yield* Effect.try({
          try: () => getNextRunTime(task.cronExpression, new Date(baseline)).getTime(),
          catch: (cause) =>
            new ScheduledTaskRunnerError({
              detail: "Scheduled task has an invalid cron expression.",
              cause,
            }),
        }).pipe(
          Effect.catch((cause) =>
            Effect.logError("scheduled task has invalid cron expression", {
              taskId: task.id,
              name: task.name,
              cronExpression: task.cronExpression,
              cause,
            }).pipe(Effect.andThen(Effect.succeed<number | null>(null))),
          ),
        );

        if (nextRunAt === null || nextRunAt > now) {
          continue;
        }

        void runPromise(executeTask(task));
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError("scheduled task polling failed", {
          cause,
        }),
      ),
    );

    const runScan = () => {
      void runPromise(scanTasks);
    };

    runScan();
    const interval = globalThis.setInterval(runScan, SCHEDULED_TASK_POLL_INTERVAL_MS);
    return interval;
  }),
  (interval) =>
    Effect.sync(() => {
      globalThis.clearInterval(interval);
    }),
);
