import type { ProviderKind, ProviderRuntimeEvent, ProviderSession, ThreadId } from "@t3tools/contracts";
import { Effect, Stream } from "effect";

import type { ServerSettingsShape } from "../../serverSettings";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter";
import type { HarnessAdapterShape } from "../Services/HarnessAdapter";
import {
  harnessUpstreamForRoutable,
  resolveHarnessUpstreamAuth,
  routableSessionModelSelectionToHarness,
  stripRoutableHarnessModelPrefix,
} from "./harnessRuntime";

type RoutedBackend = "native" | "coahcode";
type RoutedProvider = Extract<ProviderKind, "codex" | "claudeAgent">;

function rewriteSession(provider: RoutedProvider, session: ProviderSession): ProviderSession {
  return {
    ...session,
    provider,
    ...(session.model ? { model: stripRoutableHarnessModelPrefix(provider, session.model) } : {}),
  };
}

function rewriteHarnessEvent(
  provider: RoutedProvider,
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent {
  if (
    event.type === "session.configured" &&
    event.payload &&
    typeof event.payload === "object" &&
    "config" in event.payload &&
    event.payload.config &&
    typeof event.payload.config === "object" &&
    !Array.isArray(event.payload.config)
  ) {
    const config = event.payload.config as Record<string, unknown>;
    const nextModel =
      typeof config.model === "string"
        ? stripRoutableHarnessModelPrefix(provider, config.model)
        : undefined;
    return {
      ...event,
      provider,
      payload: {
        ...event.payload,
        config: {
          ...config,
          ...(nextModel ? { model: nextModel } : {}),
        },
      },
    };
  }

  return {
    ...event,
    provider,
  };
}

export function makeRoutedProviderAdapter(input: {
  readonly provider: RoutedProvider;
  readonly nativeAdapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly harnessAdapter: HarnessAdapterShape;
  readonly serverSettings: ServerSettingsShape;
}): ProviderAdapterShape<ProviderAdapterError> {
  const backendByThreadId = new Map<ThreadId, RoutedBackend>();

  const resolvePreferredBackend = (startInput: {
    readonly threadId: ThreadId;
    readonly cwd?: string;
  }) =>
    Effect.gen(function* () {
      const settings = yield* input.serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const harnessMode = settings?.assistantHarnessMode ?? "native";
      if (harnessMode !== "coahcode") {
        return "native" as const;
      }

      const auth = yield* Effect.tryPromise(() =>
        resolveHarnessUpstreamAuth({
          workspaceRoot: startInput.cwd ?? process.cwd(),
          upstream: harnessUpstreamForRoutable(input.provider),
          ...(settings
            ? {
                claudeBinaryPath: settings.providers.claudeAgent.binaryPath,
                codexBinaryPath: settings.providers.codex.binaryPath,
                codexHomePath: settings.providers.codex.homePath,
              }
            : {}),
        }),
      ).pipe(Effect.orElseSucceed(() => undefined));

      return auth ? ("coahcode" as const) : ("native" as const);
    });

  const resolveKnownBackend = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const known = backendByThreadId.get(threadId);
      if (known) {
        return known;
      }

      const hasNative = yield* input.nativeAdapter.hasSession(threadId);
      if (hasNative) {
        backendByThreadId.set(threadId, "native");
        return "native" as const;
      }

      const hasHarness = yield* input.harnessAdapter.hasSession(threadId);
      if (hasHarness) {
        backendByThreadId.set(threadId, "coahcode");
        return "coahcode" as const;
      }

      return yield* new ProviderAdapterSessionNotFoundError({
        provider: input.provider,
        threadId,
      });
    });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (startInput) =>
    Effect.gen(function* () {
      const backend = yield* resolvePreferredBackend({
        threadId: startInput.threadId,
        ...(startInput.cwd ? { cwd: startInput.cwd } : {}),
      });

      if (backend === "native") {
        const session = yield* input.nativeAdapter.startSession({
          ...startInput,
          provider: input.provider,
        });
        backendByThreadId.set(startInput.threadId, "native");
        return session;
      }

      const session = yield* input.harnessAdapter
        .startSession({
          ...startInput,
          provider: "harness",
          modelSelection: routableSessionModelSelectionToHarness(
            input.provider,
            startInput.modelSelection,
          ),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: input.provider,
                method: "session/start",
                detail: cause.message,
                cause,
              }),
          ),
        );
      backendByThreadId.set(startInput.threadId, "coahcode");
      return rewriteSession(input.provider, session);
    });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (turnInput) =>
    Effect.gen(function* () {
      const backend = yield* resolveKnownBackend(turnInput.threadId);
      if (backend === "native") {
        return yield* input.nativeAdapter.sendTurn(turnInput);
      }

      return yield* input.harnessAdapter
        .sendTurn({
          ...turnInput,
          ...(turnInput.modelSelection
            ? {
                modelSelection: routableSessionModelSelectionToHarness(
                  input.provider,
                  turnInput.modelSelection,
                ),
              }
            : {}),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: input.provider,
                method: "turn/start",
                detail: cause.message,
                cause,
              }),
          ),
        );
    });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    threadId,
    turnId,
  ) =>
    Effect.gen(function* () {
      const backend = yield* resolveKnownBackend(threadId);
      if (backend === "native") {
        return yield* input.nativeAdapter.interruptTurn(threadId, turnId);
      }
      return yield* input.harnessAdapter.interruptTurn(threadId, turnId);
    });

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const backend = yield* resolveKnownBackend(threadId);
      if (backend === "native") {
        return yield* input.nativeAdapter.respondToRequest(threadId, requestId, decision);
      }
      return yield* input.harnessAdapter.respondToRequest(threadId, requestId, decision);
    });

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const backend = yield* resolveKnownBackend(threadId);
      if (backend === "native") {
        return yield* input.nativeAdapter.respondToUserInput(threadId, requestId, answers);
      }
      return yield* input.harnessAdapter.respondToUserInput(threadId, requestId, answers);
    });

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const backend = yield* resolveKnownBackend(threadId);
      if (backend === "native") {
        yield* input.nativeAdapter.stopSession(threadId);
      } else {
        yield* input.harnessAdapter.stopSession(threadId);
      }
      backendByThreadId.delete(threadId);
    });

  const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
    Effect.gen(function* () {
      const [nativeSessions, harnessSessions] = yield* Effect.all([
        input.nativeAdapter.listSessions(),
        input.harnessAdapter.listSessions(),
      ]);

      return [
        ...nativeSessions.map((session) => {
          backendByThreadId.set(session.threadId, "native");
          return session;
        }),
        ...harnessSessions.flatMap((session) => {
          if (backendByThreadId.get(session.threadId) !== "coahcode") {
            return [];
          }
          return [rewriteSession(input.provider, session)];
        }),
      ];
    });

  const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
    resolveKnownBackend(threadId).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const backend = yield* resolveKnownBackend(threadId);
      if (backend === "native") {
        return yield* input.nativeAdapter.readThread(threadId);
      }
      return yield* input.harnessAdapter.readThread(threadId);
    });

  const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
    threadId,
    numTurns,
  ) =>
    Effect.gen(function* () {
      const backend = yield* resolveKnownBackend(threadId);
      if (backend === "native") {
        return yield* input.nativeAdapter.rollbackThread(threadId, numTurns);
      }
      return yield* input.harnessAdapter.rollbackThread(threadId, numTurns);
    });

  const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
    Effect.gen(function* () {
      const ownedThreads = [...backendByThreadId.entries()];
      for (const [threadId, backend] of ownedThreads) {
        if (backend === "native") {
          yield* input.nativeAdapter
            .stopSession(threadId)
            .pipe(Effect.orElseSucceed(() => undefined));
        } else {
          yield* input.harnessAdapter
            .stopSession(threadId)
            .pipe(Effect.orElseSucceed(() => undefined));
        }
        backendByThreadId.delete(threadId);
      }
    });

  const streamEvents = input.nativeAdapter.streamEvents.pipe(
    Stream.merge(
      input.harnessAdapter.streamEvents.pipe(
        Stream.flatMap((event: ProviderRuntimeEvent) =>
          backendByThreadId.get(event.threadId) === "coahcode"
            ? Stream.succeed(rewriteHarnessEvent(input.provider, event))
            : Stream.empty,
        ),
      ),
    ),
  );

  return {
    provider: input.provider,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents,
  };
}
