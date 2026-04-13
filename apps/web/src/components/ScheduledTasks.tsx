import {
  CalendarClockIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ScheduledTaskCreateInput,
  ScheduledTaskInfo,
  ScheduledTaskUpdateInput,
} from "@t3tools/contracts";
import { describeCron, getNextRunTime } from "@t3tools/shared/scheduler";
import {
  scheduledTasksCreateMutationOptions,
  scheduledTasksDeleteMutationOptions,
  scheduledTasksListQueryOptions,
  scheduledTasksToggleMutationOptions,
  scheduledTasksUpdateMutationOptions,
} from "~/lib/scheduledTasksReactQuery";

const PRESET_SCHEDULES = [
  { label: "Every minute", cron: "* * * * *" },
  { label: "Every 5 minutes", cron: "*/5 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at 9 AM", cron: "0 9 * * *" },
  { label: "Weekdays at 9 AM", cron: "0 9 * * 1-5" },
  { label: "Weekly on Monday", cron: "0 9 * * 1" },
] as const;

const PRESET_CRON_SET = new Set<string>(PRESET_SCHEDULES.map((preset) => preset.cron));
const CUSTOM_SCHEDULE_VALUE = "__custom__";

type TaskFormState = ScheduledTaskCreateInput;

function createBlankTaskForm(): TaskFormState {
  return {
    name: "",
    prompt: "",
    cronExpression: "0 * * * *",
    workspacePath: "",
    model: "anthropic/claude-sonnet-4-6",
  };
}

function taskToFormState(task: ScheduledTaskInfo): TaskFormState {
  return {
    name: task.name,
    prompt: task.prompt,
    cronExpression: task.cronExpression,
    workspacePath: task.workspacePath,
    model: task.model,
  };
}

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return "never";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatCountdown(durationMs: number): string {
  const clamped = Math.max(0, durationMs);
  const totalSeconds = Math.ceil(clamped / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function resolveTaskTiming(
  task: ScheduledTaskInfo,
  now: number,
): {
  readonly nextRunAt: number | null;
  readonly progress: number;
  readonly label: string;
} {
  try {
    const cycleStart = task.lastRun ?? task.createdAt ?? now;
    const nextRunAt = getNextRunTime(task.cronExpression, new Date(cycleStart)).getTime();
    const window = Math.max(1_000, nextRunAt - cycleStart);
    const elapsed = Math.max(0, now - cycleStart);
    const progress = Math.min(1, elapsed / window);

    if (!task.enabled) {
      return {
        nextRunAt,
        progress,
        label: "Paused",
      };
    }

    const remainingMs = Math.max(0, nextRunAt - now);
    return {
      nextRunAt,
      progress,
      label: remainingMs === 0 ? "Running soon" : `Runs in ${formatCountdown(remainingMs)}`,
    };
  } catch {
    return {
      nextRunAt: null,
      progress: 0,
      label: "Invalid schedule",
    };
  }
}

function TaskForm(props: {
  readonly value: TaskFormState;
  readonly onChange: (value: TaskFormState) => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly submitLabel: string;
  readonly submitPending: boolean;
}) {
  const { value, onChange, onCancel, onSubmit, submitLabel, submitPending } = props;
  const scheduleSelectValue = PRESET_CRON_SET.has(value.cronExpression)
    ? value.cronExpression
    : CUSTOM_SCHEDULE_VALUE;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-background/90 p-3">
      <input
        type="text"
        placeholder="Task name"
        value={value.name}
        onChange={(event) => onChange({ ...value, name: event.target.value })}
        className="rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <textarea
        placeholder="Tell the agent exactly what to do each time it runs."
        value={value.prompt}
        onChange={(event) => onChange({ ...value, prompt: event.target.value })}
        className="min-h-[96px] rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <input
        type="text"
        placeholder="Workspace path"
        value={value.workspacePath}
        onChange={(event) => onChange({ ...value, workspacePath: event.target.value })}
        className="rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <select
          value={scheduleSelectValue}
          onChange={(event) => {
            const next = event.target.value;
            if (next === CUSTOM_SCHEDULE_VALUE) {
              return;
            }
            onChange({ ...value, cronExpression: next });
          }}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value={CUSTOM_SCHEDULE_VALUE}>Custom schedule</option>
          {PRESET_SCHEDULES.map((preset) => (
            <option key={preset.cron} value={preset.cron}>
              {preset.label}
            </option>
          ))}
        </select>
        <select
          value={value.model}
          onChange={(event) => onChange({ ...value, model: event.target.value })}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="anthropic/claude-sonnet-4-6">Claude Sonnet 4.6</option>
          <option value="anthropic/claude-opus-4-6">Claude Opus 4.6</option>
          <option value="openai/gpt-5.4">GPT-5.4</option>
          <option value="openai/gpt-5.4-mini">GPT-5.4 Mini</option>
          <option value="anthropic/claude-haiku-4-5">Claude Haiku 4.5</option>
        </select>
      </div>
      <input
        type="text"
        spellCheck={false}
        value={value.cronExpression}
        onChange={(event) => onChange({ ...value, cronExpression: event.target.value })}
        className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
        placeholder="Cron (e.g. */10 * * * *)"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitPending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitPending ? "Saving..." : submitLabel}
        </button>
      </div>
    </div>
  );
}

function ScheduledTaskCard(props: {
  readonly task: ScheduledTaskInfo;
  readonly now: number;
  readonly isBusy: boolean;
  readonly onToggle: (task: ScheduledTaskInfo) => void;
  readonly onDelete: (id: string) => void;
  readonly onUpdate: (input: ScheduledTaskUpdateInput) => void;
}) {
  const { task, now, isBusy, onToggle, onDelete, onUpdate } = props;
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<TaskFormState>(() => taskToFormState(task));

  useEffect(() => {
    if (!isEditing) {
      setDraft(taskToFormState(task));
    }
  }, [isEditing, task]);

  const timing = useMemo(() => resolveTaskTiming(task, now), [now, task]);

  if (isEditing) {
    return (
      <TaskForm
        value={draft}
        onChange={setDraft}
        onCancel={() => {
          setDraft(taskToFormState(task));
          setIsEditing(false);
        }}
        onSubmit={() => {
          onUpdate({
            id: task.id,
            name: draft.name,
            prompt: draft.prompt,
            cronExpression: draft.cronExpression,
            workspacePath: draft.workspacePath,
            model: draft.model,
          });
          setIsEditing(false);
        }}
        submitLabel="Save changes"
        submitPending={isBusy}
      />
    );
  }

  return (
    <div
      className={`rounded-xl border border-border bg-background/80 p-3 transition-opacity ${
        task.enabled ? "opacity-100" : "opacity-70"
      }`}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => onToggle(task)}
          className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${
            task.enabled ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
          }`}
          title={task.enabled ? "Pause task" : "Resume task"}
        >
          {task.enabled ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{task.name}</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {task.enabled ? "Live" : "Paused"}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.prompt}</p>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Edit task"
          >
            <PencilIcon className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(task.id)}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="Delete task"
          >
            <TrashIcon className="size-4" />
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>{describeCron(task.cronExpression)}</span>
        <span>{timing.label}</span>
      </div>

      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-[width] duration-700 ${
            task.enabled ? "bg-primary/80" : "bg-muted-foreground/40"
          }`}
          style={{ width: `${Math.max(4, Math.round(timing.progress * 100))}%` }}
        />
      </div>

      <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
        <span className="truncate">Workspace: {task.workspacePath}</span>
        <span className="truncate">Model: {task.model}</span>
        <span>Last run: {formatRelativeTime(task.lastRun)}</span>
        <span>
          Next run:{" "}
          {timing.nextRunAt ? new Date(timing.nextRunAt).toLocaleTimeString() : "invalid cron"}
        </span>
      </div>
    </div>
  );
}

export function ScheduledTasks() {
  const queryClient = useQueryClient();
  const tasksQuery = useQuery(scheduledTasksListQueryOptions());
  const createMutation = useMutation(scheduledTasksCreateMutationOptions(queryClient));
  const updateMutation = useMutation(scheduledTasksUpdateMutationOptions(queryClient));
  const deleteMutation = useMutation(scheduledTasksDeleteMutationOptions(queryClient));
  const toggleMutation = useMutation(scheduledTasksToggleMutationOptions(queryClient));
  const [now, setNow] = useState(() => Date.now());
  const [showCreate, setShowCreate] = useState(false);
  const [newTask, setNewTask] = useState<TaskFormState>(() => createBlankTaskForm());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const tasks: readonly ScheduledTaskInfo[] = tasksQuery.data?.tasks ?? [];

  const resetCreateForm = () => {
    setNewTask(createBlankTaskForm());
    setShowCreate(false);
  };

  const handleCreate = () => {
    if (!newTask.name.trim() || !newTask.prompt.trim() || !newTask.workspacePath.trim()) {
      return;
    }
    createMutation.mutate(
      {
        ...newTask,
        name: newTask.name.trim(),
        prompt: newTask.prompt.trim(),
        workspacePath: newTask.workspacePath.trim(),
      },
      {
        onSuccess: () => {
          resetCreateForm();
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {tasks.length} task{tasks.length !== 1 ? "s" : ""}
        </span>
        <button
          type="button"
          onClick={() => setShowCreate((current) => !current)}
          className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90"
        >
          <PlusIcon className="size-3" />
          New Task
        </button>
      </div>

      {showCreate && (
        <TaskForm
          value={newTask}
          onChange={setNewTask}
          onCancel={resetCreateForm}
          onSubmit={handleCreate}
          submitLabel="Create task"
          submitPending={createMutation.isPending}
        />
      )}

      {tasks.length === 0 && !showCreate ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <CalendarClockIcon className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No scheduled tasks yet</p>
          <p className="text-xs text-muted-foreground/60">
            Schedule recurring agent runs that keep the project improving in the background.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {tasks.map((task) => (
            <ScheduledTaskCard
              key={task.id}
              task={task}
              now={now}
              isBusy={
                updateMutation.isPending || toggleMutation.isPending || deleteMutation.isPending
              }
              onToggle={(nextTask) =>
                toggleMutation.mutate({ id: nextTask.id, enabled: !nextTask.enabled })
              }
              onDelete={(id) => deleteMutation.mutate(id)}
              onUpdate={(input) => updateMutation.mutate(input)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
