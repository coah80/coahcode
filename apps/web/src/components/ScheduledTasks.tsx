import {
  CalendarClockIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from "lucide-react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScheduledTaskInfo } from "@t3tools/contracts";
import {
  scheduledTasksCreateMutationOptions,
  scheduledTasksDeleteMutationOptions,
  scheduledTasksListQueryOptions,
  scheduledTasksToggleMutationOptions,
} from "~/lib/scheduledTasksReactQuery";

const PRESET_SCHEDULES = [
  { label: "Every 5 minutes", cron: "*/5 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at 9 AM", cron: "0 9 * * *" },
  { label: "Weekdays at 9 AM", cron: "0 9 * * 1-5" },
  { label: "Weekly on Monday", cron: "0 9 * * 1" },
] as const;

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return "never";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ScheduledTasks() {
  const queryClient = useQueryClient();
  const tasksQuery = useQuery(scheduledTasksListQueryOptions());
  const createMutation = useMutation(scheduledTasksCreateMutationOptions(queryClient));
  const deleteMutation = useMutation(scheduledTasksDeleteMutationOptions(queryClient));
  const toggleMutation = useMutation(scheduledTasksToggleMutationOptions(queryClient));

  const tasks: readonly ScheduledTaskInfo[] = tasksQuery.data?.tasks ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [newTask, setNewTask] = useState({
    name: "",
    prompt: "",
    cronExpression: "0 * * * *",
    workspacePath: "",
    model: "claude-sonnet-4-6",
  });

  const handleCreate = () => {
    if (!newTask.name || !newTask.prompt) return;
    createMutation.mutate(newTask);
    setNewTask({
      name: "",
      prompt: "",
      cronExpression: "0 * * * *",
      workspacePath: "",
      model: "claude-sonnet-4-6",
    });
    setShowCreate(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {tasks.length} task{tasks.length !== 1 ? "s" : ""}
        </span>
        <button
          type="button"
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90"
        >
          <PlusIcon className="size-3" />
          New Task
        </button>
      </div>

      {showCreate && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3">
          <input
            type="text"
            placeholder="Task name"
            value={newTask.name}
            onChange={(e) => setNewTask({ ...newTask, name: e.target.value })}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          <textarea
            placeholder="Agent prompt (what should the agent do?)"
            value={newTask.prompt}
            onChange={(e) => setNewTask({ ...newTask, prompt: e.target.value })}
            className="min-h-[80px] rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          <input
            type="text"
            placeholder="Workspace path (e.g. ~/Projects/myapp)"
            value={newTask.workspacePath}
            onChange={(e) => setNewTask({ ...newTask, workspacePath: e.target.value })}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          <div className="flex gap-2">
            <select
              value={newTask.cronExpression}
              onChange={(e) => setNewTask({ ...newTask, cronExpression: e.target.value })}
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              {PRESET_SCHEDULES.map((p) => (
                <option key={p.cron} value={p.cron}>
                  {p.label}
                </option>
              ))}
            </select>
            <select
              value={newTask.model}
              onChange={(e) => setNewTask({ ...newTask, model: e.target.value })}
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
              <option value="claude-opus-4-6">Claude Opus 4.6</option>
              <option value="gpt-5.4">GPT 5.4</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={createMutation.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      )}

      {tasks.length === 0 && !showCreate ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <CalendarClockIcon className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No scheduled tasks yet</p>
          <p className="text-xs text-muted-foreground/60">
            Schedule recurring agent runs — like daily code reviews, test runs, or dependency
            updates.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`flex items-center gap-3 rounded-lg border border-border p-3 transition-opacity ${
                task.enabled ? "opacity-100" : "opacity-50"
              }`}
            >
              <button
                type="button"
                onClick={() => toggleMutation.mutate({ id: task.id, enabled: !task.enabled })}
                className={`flex size-7 shrink-0 items-center justify-center rounded-md ${
                  task.enabled
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {task.enabled ? (
                  <PauseIcon className="size-3.5" />
                ) : (
                  <PlayIcon className="size-3.5" />
                )}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{task.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {PRESET_SCHEDULES.find((p) => p.cron === task.cronExpression)?.label ??
                      task.cronExpression}
                  </span>
                </div>
                <p className="truncate text-xs text-muted-foreground">{task.prompt}</p>
                <div className="mt-0.5 flex gap-3">
                  <span className="text-[10px] text-muted-foreground/60">
                    Last run: {formatRelativeTime(task.lastRun)}
                  </span>
                  <span className="text-[10px] text-muted-foreground/60">Model: {task.model}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => deleteMutation.mutate(task.id)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <TrashIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
