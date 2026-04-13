import {
  ArchiveIcon,
  ArchiveX,
  ChevronDownIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ScopedThreadRef,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { DEFAULT_UNIFIED_SETTINGS, type AssistantHarnessMode } from "@t3tools/contracts/settings";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { Equal } from "effect";
import { APP_VERSION } from "../../branding";
import { ScheduledTasks } from "../ScheduledTasks";
import { WorkspacePicker } from "../WorkspacePicker";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  MAX_CUSTOM_MODEL_LENGTH,
  getCustomModelOptionsByProvider,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useShallow } from "zustand/react/shallow";
import {
  selectProjectsAcrossEnvironments,
  selectThreadShellsAcrossEnvironments,
  useStore,
} from "../../store";
import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  useServerAvailableEditors,
  useServerKeybindingsConfigPath,
  useServerObservability,
  useServerProviders,
} from "../../rpc/serverState";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  showBinaryPath?: boolean;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: "harness",
    title: "CoahCode Runtime",
    binaryPlaceholder: "",
    binaryDescription:
      "Configures MCP, LSP, skills, and the CoahCode runtime backend used behind Claude and Codex.",
    showBinaryPath: false,
  },
] as const;

const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in T3 Code.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

function splitCommandInput(value: string): string[] {
  const matches = value.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g) ?? [];
  return matches
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/^['"]|['"]$/g, ""));
}

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();

  const updateState = updateStateQuery.data ?? null;

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          });
        });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "Install failed.",
          });
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          });
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not check for updates",
          description: error instanceof Error ? error.message : "Update check failed.",
        });
      });
  }, [queryClient, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <SettingsRow
      title={<AboutVersionTitle />}
      description={description}
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant={action === "install" ? "default" : "outline"}
                disabled={buttonDisabled}
                onClick={handleButtonClick}
              >
                {buttonLabel}
              </Button>
            }
          />
          {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
        </Tooltip>
      }
    />
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { resetSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const areProviderSettingsDirty = PROVIDER_SETTINGS.some((providerSettings) => {
    const currentSettings = settings.providers[providerSettings.provider];
    const defaultSettings = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    return !Equal.equals(currentSettings, defaultSettings);
  });

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(areProviderSettingsDirty ? ["Providers"] : []),
    ],
    [
      areProviderSettingsDirty,
      isGitWritingModelDirty,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.defaultThreadEnvMode,
      settings.diffWordWrap,
      settings.enableAssistantStreaming,
      settings.timestampFormat,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    resetSettings();
    onRestored?.();
  }, [changedSettingLabels, onRestored, resetSettings, setTheme]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

export function GeneralSettingsPanel() {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [openingPathByTarget, setOpeningPathByTarget] = useState({
    keybindings: false,
    logsDirectory: false,
  });
  const [openPathErrorByTarget, setOpenPathErrorByTarget] = useState<
    Partial<Record<"keybindings" | "logsDirectory", string | null>>
  >({});
  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(
      settings.providers.codex.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.binaryPath ||
      settings.providers.codex.homePath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.homePath ||
      settings.providers.codex.customModels.length > 0,
    ),
    claudeAgent: Boolean(
      settings.providers.claudeAgent.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.binaryPath ||
      settings.providers.claudeAgent.customModels.length > 0,
    ),
    harness: Boolean(settings.providers.harness.customModels.length > 0),
  });
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
    harness: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [newHarnessMcp, setNewHarnessMcp] = useState({
    name: "",
    type: "local" as const,
    target: "",
  });
  const [newHarnessMcpError, setNewHarnessMcpError] = useState<string | null>(null);
  const [newHarnessLsp, setNewHarnessLsp] = useState({
    id: "",
    extensions: "",
    command: "",
    rootMarkers: "",
  });
  const [newHarnessLspError, setNewHarnessLspError] = useState<string | null>(null);
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});
  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureLocalApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const copyCliLoginCommand = useCallback((command: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add({
        type: "error",
        title: "Could not copy",
        description: "Copy the command text manually.",
      });
      return;
    }
    void navigator.clipboard.writeText(command).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Command copied",
          description:
            "Run it in a terminal on the same machine as the server, press Enter, then tap Refresh status.",
        });
      },
      () => {
        toastManager.add({
          type: "error",
          title: "Could not copy",
          description: "Copy the command text manually.",
        });
      },
    );
  }, []);

  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const availableEditors = useServerAvailableEditors();
  const observability = useServerObservability();
  const serverProviders = useServerProviders();
  const codexHomePath = settings.providers.codex.homePath;
  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
  const diagnosticsDescription = (() => {
    const exports: string[] = [];
    if (observability?.otlpTracesEnabled && observability.otlpTracesUrl) {
      exports.push(`traces to ${observability.otlpTracesUrl}`);
    }
    if (observability?.otlpMetricsEnabled && observability.otlpMetricsUrl) {
      exports.push(`metrics to ${observability.otlpMetricsUrl}`);
    }
    const mode = observability?.localTracingEnabled ? "Local trace file" : "Terminal logs only";
    return exports.length > 0 ? `${mode}. OTLP exporting ${exports.join(" and ")}.` : `${mode}.`;
  })();

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    serverProviders,
    textGenProvider,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const openInPreferredEditor = useCallback(
    (target: "keybindings" | "logsDirectory", path: string | null, failureMessage: string) => {
      if (!path) return;
      setOpenPathErrorByTarget((existing) => ({ ...existing, [target]: null }));
      setOpeningPathByTarget((existing) => ({ ...existing, [target]: true }));

      const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
      if (!editor) {
        setOpenPathErrorByTarget((existing) => ({
          ...existing,
          [target]: "No available editors found.",
        }));
        setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        return;
      }

      void ensureLocalApi()
        .shell.openInEditor(path, editor)
        .catch((error) => {
          setOpenPathErrorByTarget((existing) => ({
            ...existing,
            [target]: error instanceof Error ? error.message : failureMessage,
          }));
        })
        .finally(() => {
          setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        });
    },
    [availableEditors],
  );

  const openKeybindingsFile = useCallback(() => {
    openInPreferredEditor("keybindings", keybindingsConfigPath, "Unable to open keybindings file.");
  }, [keybindingsConfigPath, openInPreferredEditor]);

  const openLogsDirectory = useCallback(() => {
    openInPreferredEditor("logsDirectory", logsDirectoryPath, "Unable to open logs folder.");
  }, [logsDirectoryPath, openInPreferredEditor]);

  const openKeybindingsError = openPathErrorByTarget.keybindings ?? null;
  const openDiagnosticsError = openPathErrorByTarget.logsDirectory ?? null;
  const isOpeningKeybindings = openingPathByTarget.keybindings;
  const isOpeningLogsDirectory = openingPathByTarget.logsDirectory;

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = settings.providers[provider].customModels;
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (
        serverProviders
          .find((candidate) => candidate.provider === provider)
          ?.models.some((option) => !option.isCustom && option.slug === normalized)
      ) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: [...customModels, normalized],
          },
        },
      });
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));

      const el = modelListRefs.current[provider];
      if (!el) return;
      const scrollToEnd = () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      requestAnimationFrame(scrollToEnd);
      const observer = new MutationObserver(() => {
        scrollToEnd();
        observer.disconnect();
      });
      observer.observe(el, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 2_000);
    },
    [customModelInputByProvider, serverProviders, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: settings.providers[provider].customModels.filter(
              (model) => model !== slug,
            ),
          },
        },
      });
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const addHarnessMcpServer = useCallback(() => {
    const name = newHarnessMcp.name.trim();
    const target = newHarnessMcp.target.trim();
    if (!name) {
      setNewHarnessMcpError("Enter a server name.");
      return;
    }
    if (!target) {
      setNewHarnessMcpError(
        newHarnessMcp.type === "local" ? "Enter a command." : "Enter a server URL.",
      );
      return;
    }

    const nextServer =
      newHarnessMcp.type === "local"
        ? {
            name,
            type: "local" as const,
            command: splitCommandInput(target),
            enabled: true,
          }
        : {
            name,
            type: "remote" as const,
            url: target,
            enabled: true,
          };

    if (settings.providers.harness.mcpServers.some((server) => server.name === nextServer.name)) {
      setNewHarnessMcpError("That MCP server name is already saved.");
      return;
    }

    if (
      newHarnessMcp.type === "local" &&
      (!("command" in nextServer) || nextServer.command.length === 0)
    ) {
      setNewHarnessMcpError("Enter a valid command.");
      return;
    }

    updateSettings({
      providers: {
        ...settings.providers,
        harness: {
          ...settings.providers.harness,
          mcpServers: [...settings.providers.harness.mcpServers, nextServer],
        },
      },
    });
    setNewHarnessMcp({ name: "", type: "local", target: "" });
    setNewHarnessMcpError(null);
  }, [newHarnessMcp, settings.providers, updateSettings]);

  const removeHarnessMcpServer = useCallback(
    (name: string) => {
      updateSettings({
        providers: {
          ...settings.providers,
          harness: {
            ...settings.providers.harness,
            mcpServers: settings.providers.harness.mcpServers.filter(
              (server) => server.name !== name,
            ),
          },
        },
      });
    },
    [settings.providers, updateSettings],
  );

  const toggleHarnessMcpServer = useCallback(
    (name: string, enabled: boolean) => {
      updateSettings({
        providers: {
          ...settings.providers,
          harness: {
            ...settings.providers.harness,
            mcpServers: settings.providers.harness.mcpServers.map((server) =>
              server.name === name ? { ...server, enabled } : server,
            ),
          },
        },
      });
    },
    [settings.providers, updateSettings],
  );

  const addHarnessLspServer = useCallback(() => {
    const id = newHarnessLsp.id.trim();
    const extensions = newHarnessLsp.extensions
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const command = splitCommandInput(newHarnessLsp.command);
    const rootMarkers = newHarnessLsp.rootMarkers
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (!id) {
      setNewHarnessLspError("Enter an LSP server id.");
      return;
    }
    if (extensions.length === 0) {
      setNewHarnessLspError("Enter at least one file extension.");
      return;
    }
    if (command.length === 0) {
      setNewHarnessLspError("Enter a command.");
      return;
    }
    if (settings.providers.harness.lspServers.some((server) => server.id === id)) {
      setNewHarnessLspError("That LSP server id is already saved.");
      return;
    }

    updateSettings({
      providers: {
        ...settings.providers,
        harness: {
          ...settings.providers.harness,
          lspServers: [
            ...settings.providers.harness.lspServers,
            {
              id,
              extensions,
              command,
              rootMarkers,
            },
          ],
        },
      },
    });
    setNewHarnessLsp({
      id: "",
      extensions: "",
      command: "",
      rootMarkers: "",
    });
    setNewHarnessLspError(null);
  }, [newHarnessLsp, settings.providers, updateSettings]);

  const removeHarnessLspServer = useCallback(
    (id: string) => {
      updateSettings({
        providers: {
          ...settings.providers,
          harness: {
            ...settings.providers.harness,
            lspServers: settings.providers.harness.lspServers.filter((server) => server.id !== id),
          },
        },
      });
    },
    [settings.providers, updateSettings],
  );

  const providerCards = PROVIDER_SETTINGS.map((providerSettings) => {
    const liveProvider = serverProviders.find(
      (candidate) => candidate.provider === providerSettings.provider,
    );
    const providerConfig = settings.providers[providerSettings.provider];
    const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    const statusKey = liveProvider?.status ?? (providerConfig.enabled ? "warning" : "disabled");
    const summary = getProviderSummary(liveProvider);
    const models: ReadonlyArray<ServerProviderModel> =
      liveProvider?.models ??
      providerConfig.customModels.map((slug) => ({
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      }));

    return {
      provider: providerSettings.provider,
      title: providerSettings.title,
      binaryPlaceholder: providerSettings.binaryPlaceholder,
      binaryDescription: providerSettings.binaryDescription,
      showBinaryPath: providerSettings.showBinaryPath !== false,
      homePathKey: providerSettings.homePathKey,
      homePlaceholder: providerSettings.homePlaceholder,
      homeDescription: providerSettings.homeDescription,
      binaryPathValue: "binaryPath" in providerConfig ? providerConfig.binaryPath : "",
      isDirty: !Equal.equals(providerConfig, defaultProviderConfig),
      liveProvider,
      models,
      providerConfig,
      statusStyle: PROVIDER_STATUS_STYLES[statusKey],
      summary,
      versionLabel: getProviderVersionLabel(liveProvider?.version),
    };
  });

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="General">
        <SettingsRow
          title="Theme"
          description="Choose how T3 Code looks across the app."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Diff line wrapping"
          description="Set the default wrap state when the diff panel opens."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="diff line wrapping"
                onClick={() =>
                  updateSettings({
                    diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap diff lines by default"
            />
          }
        />

        <SettingsRow
          title="Assistant output"
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />

        <SettingsRow
          title="Assistant harness"
          description="Choose whether chat sessions prefer the native provider runtime or the CoahCode runtime. CoahCode falls back to the native runtime when upstream auth is unavailable."
          resetAction={
            settings.assistantHarnessMode !== DEFAULT_UNIFIED_SETTINGS.assistantHarnessMode ? (
              <SettingResetButton
                label="assistant harness"
                onClick={() =>
                  updateSettings({
                    assistantHarnessMode: DEFAULT_UNIFIED_SETTINGS.assistantHarnessMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.assistantHarnessMode}
              onValueChange={(value) => {
                if (value === "native" || value === "coahcode") {
                  updateSettings({ assistantHarnessMode: value as AssistantHarnessMode });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Assistant harness mode">
                <SelectValue>
                  {settings.assistantHarnessMode === "coahcode" ? "CoahCode" : "Native"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="coahcode">
                  CoahCode
                </SelectItem>
                <SelectItem hideIndicator value="native">
                  Native
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="CoahCode harness · Claude and Codex subscriptions"
          description="Set Assistant harness to CoahCode. Claude: use anthropic/… models with no ANTHROPIC_API_KEY (run `claude auth login` or `claude setup-token` + CLAUDE_CODE_OAUTH_TOKEN on the server). Codex: use openai/… models with no OPENAI_API_KEY (run `codex login`). See https://code.claude.com/docs/en/authentication and https://developers.openai.com/codex — then refresh Providers below."
        />

        <SettingsRow
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Local
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Archive confirmation"
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          title="Delete confirmation"
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

        <SettingsRow
          title="Text generation model"
          description="Configure the model used for generated commit messages, PR titles, and similar Git text."
          resetAction={
            isGitWritingModelDirty ? (
              <SettingResetButton
                label="text generation model"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                provider={textGenProvider}
                model={textGenModel}
                lockedProvider={null}
                providers={serverProviders}
                modelOptionsByProvider={gitModelOptionsByProvider}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onProviderModelChange={(provider, model) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: { provider, model },
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
              <TraitsPicker
                provider={textGenProvider}
                models={
                  serverProviders.find((provider) => provider.provider === textGenProvider)
                    ?.models ?? []
                }
                model={textGenModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: {
                          provider: textGenProvider,
                          model: textGenModel,
                          ...(nextOptions ? { options: nextOptions } : {}),
                        },
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {providerCards.map((providerCard) => {
          const customModelInput = customModelInputByProvider[providerCard.provider];
          const customModelError = customModelErrorByProvider[providerCard.provider] ?? null;
          const providerDisplayName =
            PROVIDER_DISPLAY_NAMES[providerCard.provider] ?? providerCard.title;

          return (
            <div key={providerCard.provider} className="border-t border-border first:border-t-0">
              <div className="px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-h-5 items-center gap-1.5">
                      <span
                        className={cn("size-2 shrink-0 rounded-full", providerCard.statusStyle.dot)}
                      />
                      <h3 className="text-sm font-medium text-foreground">{providerDisplayName}</h3>
                      {providerCard.versionLabel ? (
                        <code className="text-xs text-muted-foreground">
                          {providerCard.versionLabel}
                        </code>
                      ) : null}
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                        {providerCard.isDirty ? (
                          <SettingResetButton
                            label={`${providerDisplayName} provider settings`}
                            onClick={() => {
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  [providerCard.provider]:
                                    DEFAULT_UNIFIED_SETTINGS.providers[providerCard.provider],
                                },
                              });
                              setCustomModelErrorByProvider((existing) => ({
                                ...existing,
                                [providerCard.provider]: null,
                              }));
                            }}
                          />
                        ) : null}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {providerCard.summary.headline}
                      {providerCard.summary.detail ? ` - ${providerCard.summary.detail}` : null}
                    </p>
                  </div>
                  <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setOpenProviderDetails((existing) => ({
                          ...existing,
                          [providerCard.provider]: !existing[providerCard.provider],
                        }))
                      }
                      aria-label={`Toggle ${providerDisplayName} details`}
                    >
                      <ChevronDownIcon
                        className={cn(
                          "size-3.5 transition-transform",
                          openProviderDetails[providerCard.provider] && "rotate-180",
                        )}
                      />
                    </Button>
                    <Switch
                      checked={providerCard.providerConfig.enabled}
                      onCheckedChange={(checked) => {
                        const isDisabling = !checked;
                        const shouldClearModelSelection =
                          isDisabling && textGenProvider === providerCard.provider;
                        updateSettings({
                          providers: {
                            ...settings.providers,
                            [providerCard.provider]: {
                              ...settings.providers[providerCard.provider],
                              enabled: Boolean(checked),
                            },
                          },
                          ...(shouldClearModelSelection
                            ? {
                                textGenerationModelSelection:
                                  DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                              }
                            : {}),
                        });
                      }}
                      aria-label={`Enable ${providerDisplayName}`}
                    />
                  </div>
                </div>
              </div>

              <Collapsible
                open={openProviderDetails[providerCard.provider]}
                onOpenChange={(open) =>
                  setOpenProviderDetails((existing) => ({
                    ...existing,
                    [providerCard.provider]: open,
                  }))
                }
              >
                <CollapsibleContent>
                  <div className="space-y-0">
                    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                      {providerCard.showBinaryPath ? (
                        <label
                          htmlFor={`provider-install-${providerCard.provider}-binary-path`}
                          className="block"
                        >
                          <span className="text-xs font-medium text-foreground">
                            {providerDisplayName} binary path
                          </span>
                          <Input
                            id={`provider-install-${providerCard.provider}-binary-path`}
                            className="mt-1.5"
                            value={providerCard.binaryPathValue}
                            onChange={(event) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  [providerCard.provider]: {
                                    ...settings.providers[providerCard.provider],
                                    binaryPath: event.target.value,
                                  },
                                },
                              })
                            }
                            placeholder={providerCard.binaryPlaceholder}
                            spellCheck={false}
                          />
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {providerCard.binaryDescription}
                          </span>
                        </label>
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          {providerCard.binaryDescription}
                        </div>
                      )}
                    </div>

                    {providerCard.homePathKey ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <label
                          htmlFor={`provider-install-${providerCard.homePathKey}`}
                          className="block"
                        >
                          <span className="text-xs font-medium text-foreground">
                            CODEX_HOME path
                          </span>
                          <Input
                            id={`provider-install-${providerCard.homePathKey}`}
                            className="mt-1.5"
                            value={codexHomePath}
                            onChange={(event) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  codex: {
                                    ...settings.providers.codex,
                                    homePath: event.target.value,
                                  },
                                },
                              })
                            }
                            placeholder={providerCard.homePlaceholder}
                            spellCheck={false}
                          />
                          {providerCard.homeDescription ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {providerCard.homeDescription}
                            </span>
                          ) : null}
                        </label>
                      </div>
                    ) : null}

                    {providerCard.provider === "claudeAgent" ||
                    providerCard.provider === "codex" ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <div className="text-xs font-medium text-foreground">
                          {providerCard.provider === "claudeAgent"
                            ? "Claude login (native + CoahCode harness)"
                            : "Codex login (native + CoahCode harness)"}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {providerCard.provider === "claudeAgent"
                            ? "Same CLI session powers native Claude threads and harness turns with anthropic/… models. Unset ANTHROPIC_API_KEY on the server if you want subscription instead of Console API keys."
                            : "Same CLI session powers native Codex threads and harness turns with openai/… models. Unset OPENAI_API_KEY on the server if you want ChatGPT-backed Codex instead of the OpenAI API."}
                          {providerCard.provider === "codex" && codexHomePath.trim().length > 0
                            ? ` Use CODEX_HOME=${codexHomePath.trim()} in that shell when you log in so it matches the path above.`
                            : null}
                        </p>
                        {(() => {
                          const bin =
                            providerCard.binaryPathValue.trim() ||
                            (providerCard.provider === "claudeAgent" ? "claude" : "codex");
                          const loginCmd =
                            providerCard.provider === "claudeAgent"
                              ? `${bin} auth login`
                              : `${bin} login`;
                          const lp = providerCard.liveProvider;
                          const isLoggedIn =
                            lp?.installed === true && lp.auth.status === "authenticated";

                          if (isLoggedIn) {
                            return (
                              <div className="mt-2 flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                                <CircleCheckIcon className="size-4 shrink-0" aria-hidden />
                                Logged in!
                              </div>
                            );
                          }

                          return (
                            <div className="mt-2 space-y-2">
                              {!lp?.installed ? (
                                <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
                                  {providerCard.provider === "claudeAgent"
                                    ? "Install the Claude Code CLI first (for example npm install -g @anthropic-ai/claude-code), then log in."
                                    : "Install the Codex CLI first, then log in."}
                                </p>
                              ) : null}
                              <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5 font-mono text-[11px] text-foreground">
                                {loginCmd}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="default"
                                  onClick={() => copyCliLoginCommand(loginCmd)}
                                >
                                  Log in
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void refreshProviders()}
                                >
                                  Refresh status
                                </Button>
                              </div>
                              <p className="text-[11px] text-muted-foreground">
                                {providerCard.provider === "claudeAgent" ? (
                                  <a
                                    className="text-primary underline-offset-2 hover:underline"
                                    href="https://code.claude.com/docs/en/authentication"
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Claude Code authentication
                                  </a>
                                ) : (
                                  <a
                                    className="text-primary underline-offset-2 hover:underline"
                                    href="https://developers.openai.com/codex"
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Codex CLI docs
                                  </a>
                                )}
                              </p>
                            </div>
                          );
                        })()}
                      </div>
                    ) : null}

                    {providerCard.provider === "harness" ? (
                      <>
                        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-xs font-medium text-foreground">
                                Built-in LSP servers
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                TypeScript, Python, Go, Rust, and CSS auto-start on demand.
                              </div>
                            </div>
                            <Switch
                              checked={settings.providers.harness.enableBuiltinLsp}
                              onCheckedChange={(checked) =>
                                updateSettings({
                                  providers: {
                                    ...settings.providers,
                                    harness: {
                                      ...settings.providers.harness,
                                      enableBuiltinLsp: Boolean(checked),
                                    },
                                  },
                                })
                              }
                              aria-label="Enable built-in harness LSP servers"
                            />
                          </div>
                        </div>

                        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                          <div className="text-xs font-medium text-foreground">
                            Workspace skills
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            Skills are auto-discovered from Claude, Cursor, Codex, and OpenCode
                            folders, plus any extra `skills.paths` declared in `opencode.json` or
                            `opencode.jsonc`.
                          </div>
                          <div className="mt-2 space-y-2">
                            {(providerCard.liveProvider?.skills ?? []).length === 0 ? (
                              <p className="text-xs text-muted-foreground">No skills discovered.</p>
                            ) : (
                              (providerCard.liveProvider?.skills ?? []).map((skill) => (
                                <div
                                  key={skill.path}
                                  className="rounded-lg border border-border/70 bg-muted/25 px-3 py-2"
                                >
                                  <div className="text-xs font-medium text-foreground">
                                    {skill.displayName}
                                  </div>
                                  {skill.shortDescription ? (
                                    <div className="mt-1 text-xs text-muted-foreground">
                                      {skill.shortDescription}
                                    </div>
                                  ) : null}
                                  <code className="mt-1 block break-all text-[11px] text-muted-foreground/80">
                                    {skill.path}
                                  </code>
                                </div>
                              ))
                            )}
                          </div>
                        </div>

                        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                          <div className="text-xs font-medium text-foreground">MCP servers</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            Add local stdio servers or remote MCP endpoints for the harness.
                            OpenCode MCP config is imported automatically, and entries here win on
                            name conflicts.
                          </div>
                          <div className="mt-2 space-y-2">
                            {settings.providers.harness.mcpServers.length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                No MCP servers configured.
                              </p>
                            ) : (
                              settings.providers.harness.mcpServers.map((server) => (
                                <div
                                  key={server.name}
                                  className="flex items-start gap-3 rounded-lg border border-border/70 bg-muted/25 px-3 py-2"
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-medium text-foreground">
                                        {server.name}
                                      </span>
                                      <span className="rounded bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                                        {server.type}
                                      </span>
                                    </div>
                                    <code className="mt-1 block break-all text-[11px] text-muted-foreground/80">
                                      {server.type === "local"
                                        ? (server.command ?? []).join(" ")
                                        : (server.url ?? "")}
                                    </code>
                                  </div>
                                  <Switch
                                    checked={server.enabled}
                                    onCheckedChange={(checked) =>
                                      toggleHarnessMcpServer(server.name, Boolean(checked))
                                    }
                                    aria-label={`Toggle ${server.name}`}
                                  />
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    className="size-6"
                                    onClick={() => removeHarnessMcpServer(server.name)}
                                  >
                                    <XIcon className="size-3.5" />
                                  </Button>
                                </div>
                              ))
                            )}
                          </div>

                          <div className="mt-3 grid gap-2 sm:grid-cols-[140px_minmax(0,1fr)_auto]">
                            <Input
                              value={newHarnessMcp.name}
                              onChange={(event) => {
                                setNewHarnessMcp((current) => ({
                                  ...current,
                                  name: event.target.value,
                                }));
                                if (newHarnessMcpError) {
                                  setNewHarnessMcpError(null);
                                }
                              }}
                              placeholder="filesystem"
                              spellCheck={false}
                            />
                            <Input
                              value={newHarnessMcp.target}
                              onChange={(event) => {
                                setNewHarnessMcp((current) => ({
                                  ...current,
                                  target: event.target.value,
                                }));
                                if (newHarnessMcpError) {
                                  setNewHarnessMcpError(null);
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  addHarnessMcpServer();
                                }
                              }}
                              placeholder={
                                newHarnessMcp.type === "local"
                                  ? "npx @modelcontextprotocol/server-filesystem ~/Projects"
                                  : "https://example.com/mcp"
                              }
                              spellCheck={false}
                            />
                            <Select
                              value={newHarnessMcp.type}
                              onValueChange={(value) => {
                                if (value === "local" || value === "remote") {
                                  setNewHarnessMcp((current) => ({
                                    ...current,
                                    type: value,
                                  }));
                                  setNewHarnessMcpError(null);
                                }
                              }}
                            >
                              <SelectTrigger className="w-full sm:w-28">
                                <SelectValue>{newHarnessMcp.type}</SelectValue>
                              </SelectTrigger>
                              <SelectPopup align="end" alignItemWithTrigger={false}>
                                <SelectItem hideIndicator value="local">
                                  local
                                </SelectItem>
                                <SelectItem hideIndicator value="remote">
                                  remote
                                </SelectItem>
                              </SelectPopup>
                            </Select>
                          </div>
                          <div className="mt-2 flex justify-end">
                            <Button size="sm" variant="outline" onClick={addHarnessMcpServer}>
                              <PlusIcon className="size-3.5" />
                              Add MCP server
                            </Button>
                          </div>
                          {newHarnessMcpError ? (
                            <p className="mt-2 text-xs text-destructive">{newHarnessMcpError}</p>
                          ) : null}
                        </div>

                        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                          <div className="text-xs font-medium text-foreground">
                            Custom LSP servers
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            Add language servers beyond the built-in set. Use comma-separated file
                            extensions and root markers.
                          </div>
                          <div className="mt-2 space-y-2">
                            {settings.providers.harness.lspServers.length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                No custom LSP servers configured.
                              </p>
                            ) : (
                              settings.providers.harness.lspServers.map((server) => (
                                <div
                                  key={server.id}
                                  className="flex items-start gap-3 rounded-lg border border-border/70 bg-muted/25 px-3 py-2"
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="text-xs font-medium text-foreground">
                                      {server.id}
                                    </div>
                                    <div className="mt-1 text-[11px] text-muted-foreground">
                                      Extensions: {server.extensions.join(", ")}
                                    </div>
                                    <code className="mt-1 block break-all text-[11px] text-muted-foreground/80">
                                      {server.command.join(" ")}
                                    </code>
                                  </div>
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    className="size-6"
                                    onClick={() => removeHarnessLspServer(server.id)}
                                  >
                                    <XIcon className="size-3.5" />
                                  </Button>
                                </div>
                              ))
                            )}
                          </div>

                          <div className="mt-3 grid gap-2">
                            <Input
                              value={newHarnessLsp.id}
                              onChange={(event) => {
                                setNewHarnessLsp((current) => ({
                                  ...current,
                                  id: event.target.value,
                                }));
                                if (newHarnessLspError) {
                                  setNewHarnessLspError(null);
                                }
                              }}
                              placeholder="typescript-eslint"
                              spellCheck={false}
                            />
                            <Input
                              value={newHarnessLsp.extensions}
                              onChange={(event) => {
                                setNewHarnessLsp((current) => ({
                                  ...current,
                                  extensions: event.target.value,
                                }));
                                if (newHarnessLspError) {
                                  setNewHarnessLspError(null);
                                }
                              }}
                              placeholder=".ts,.tsx"
                              spellCheck={false}
                            />
                            <Input
                              value={newHarnessLsp.command}
                              onChange={(event) => {
                                setNewHarnessLsp((current) => ({
                                  ...current,
                                  command: event.target.value,
                                }));
                                if (newHarnessLspError) {
                                  setNewHarnessLspError(null);
                                }
                              }}
                              placeholder="typescript-language-server --stdio"
                              spellCheck={false}
                            />
                            <Input
                              value={newHarnessLsp.rootMarkers}
                              onChange={(event) => {
                                setNewHarnessLsp((current) => ({
                                  ...current,
                                  rootMarkers: event.target.value,
                                }));
                                if (newHarnessLspError) {
                                  setNewHarnessLspError(null);
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  addHarnessLspServer();
                                }
                              }}
                              placeholder="package.json,tsconfig.json"
                              spellCheck={false}
                            />
                          </div>
                          <div className="mt-2 flex justify-end">
                            <Button size="sm" variant="outline" onClick={addHarnessLspServer}>
                              <PlusIcon className="size-3.5" />
                              Add LSP server
                            </Button>
                          </div>
                          {newHarnessLspError ? (
                            <p className="mt-2 text-xs text-destructive">{newHarnessLspError}</p>
                          ) : null}
                        </div>
                      </>
                    ) : null}

                    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                      <div className="text-xs font-medium text-foreground">Models</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {providerCard.models.length} model
                        {providerCard.models.length === 1 ? "" : "s"} available.
                      </div>
                      <div
                        ref={(el) => {
                          modelListRefs.current[providerCard.provider] = el;
                        }}
                        className="mt-2 max-h-40 overflow-y-auto pb-1"
                      >
                        {providerCard.models.map((model) => {
                          const caps = model.capabilities;
                          const capLabels: string[] = [];
                          if (caps?.supportsFastMode) capLabels.push("Fast mode");
                          if (caps?.supportsThinkingToggle) capLabels.push("Thinking");
                          if (
                            caps?.reasoningEffortLevels &&
                            caps.reasoningEffortLevels.length > 0
                          ) {
                            capLabels.push("Reasoning");
                          }
                          const hasDetails = capLabels.length > 0 || model.name !== model.slug;

                          return (
                            <div
                              key={`${providerCard.provider}:${model.slug}`}
                              className="flex items-center gap-2 py-1"
                            >
                              <span className="min-w-0 truncate text-xs text-foreground/90">
                                {model.name}
                              </span>
                              {hasDetails ? (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <button
                                        type="button"
                                        className="shrink-0 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
                                        aria-label={`Details for ${model.name}`}
                                      />
                                    }
                                  >
                                    <InfoIcon className="size-3" />
                                  </TooltipTrigger>
                                  <TooltipPopup side="top" className="max-w-56">
                                    <div className="space-y-1">
                                      <code className="block text-[11px] text-foreground">
                                        {model.slug}
                                      </code>
                                      {capLabels.length > 0 ? (
                                        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                                          {capLabels.map((label) => (
                                            <span
                                              key={label}
                                              className="text-[10px] text-muted-foreground"
                                            >
                                              {label}
                                            </span>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  </TooltipPopup>
                                </Tooltip>
                              ) : null}
                              {model.isCustom ? (
                                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                  <span className="text-[10px] text-muted-foreground">custom</span>
                                  <button
                                    type="button"
                                    className="text-muted-foreground transition-colors hover:text-foreground"
                                    aria-label={`Remove ${model.slug}`}
                                    onClick={() =>
                                      removeCustomModel(providerCard.provider, model.slug)
                                    }
                                  >
                                    <XIcon className="size-3" />
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>

                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <Input
                          id={`custom-model-${providerCard.provider}`}
                          value={customModelInput}
                          onChange={(event) => {
                            const value = event.target.value;
                            setCustomModelInputByProvider((existing) => ({
                              ...existing,
                              [providerCard.provider]: value,
                            }));
                            if (customModelError) {
                              setCustomModelErrorByProvider((existing) => ({
                                ...existing,
                                [providerCard.provider]: null,
                              }));
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            addCustomModel(providerCard.provider);
                          }}
                          placeholder={
                            providerCard.provider === "codex"
                              ? "gpt-6.7-codex-ultra-preview"
                              : "claude-sonnet-5-0"
                          }
                          spellCheck={false}
                        />
                        <Button
                          className="shrink-0"
                          variant="outline"
                          onClick={() => addCustomModel(providerCard.provider)}
                        >
                          <PlusIcon className="size-3.5" />
                          Add
                        </Button>
                      </div>

                      {customModelError ? (
                        <p className="mt-2 text-xs text-destructive">{customModelError}</p>
                      ) : null}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          );
        })}
      </SettingsSection>

      <SettingsSection title="Advanced">
        <SettingsRow
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings ? "Opening..." : "Open file"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Workspaces">
        <div className="px-1">
          <WorkspacePicker />
        </div>
      </SettingsSection>

      <SettingsSection title="About">
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
        <SettingsRow
          title="Diagnostics"
          description={diagnosticsDescription}
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {logsDirectoryPath ?? "Resolving logs directory..."}
              </span>
              {openDiagnosticsError ? (
                <span className="mt-1 block text-destructive">{openDiagnosticsError}</span>
              ) : null}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!logsDirectoryPath || isOpeningLogsDirectory}
              onClick={openLogsDirectory}
            >
              {isOpeningLogsDirectory ? "Opening..." : "Open logs folder"}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ScheduledTasksSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection title="Scheduled Tasks" anchorId="scheduled-tasks">
        <div className="px-1">
          <ScheduledTasks />
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const archivedGroups = useMemo(() => {
    return projects
      .map((project) => ({
        project,
        threads: threads
          .filter((thread) => thread.projectId === project.id && thread.archivedAt !== null)
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
      }))
      .filter((group) => group.threads.length > 0);
  }, [projects, threads]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadRef);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to unarchive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }

      if (clicked === "delete") {
        await confirmAndDeleteThread(threadRef);
      }
    },
    [confirmAndDeleteThread, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived threads</EmptyTitle>
              <EmptyDescription>Archived threads will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project.id}
            title={project.name}
            icon={
              <ProjectFavicon
                environmentId={project.environmentId}
                cwd={project.cwd}
                projectIcon={project.icon}
              />
            }
          >
            {projectThreads.map((thread) => (
              <div
                key={thread.id}
                className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleArchivedThreadContextMenu(
                    scopeThreadRef(thread.environmentId, thread.id),
                    {
                      x: event.clientX,
                      y: event.clientY,
                    },
                  );
                }}
              >
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium text-foreground">{thread.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                  onClick={() =>
                    void unarchiveThread(scopeThreadRef(thread.environmentId, thread.id)).catch(
                      (error) => {
                        toastManager.add({
                          type: "error",
                          title: "Failed to unarchive thread",
                          description:
                            error instanceof Error ? error.message : "An error occurred.",
                        });
                      },
                    )
                  }
                >
                  <ArchiveX className="size-3.5" />
                  <span>Unarchive</span>
                </Button>
              </div>
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
