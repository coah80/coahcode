import { queryOptions, mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { ScheduledTaskUpdateInput } from "@t3tools/contracts";
import { ensureLocalApi } from "../localApi";

export const scheduledTasksQueryKeys = {
  all: ["scheduledTasks"] as const,
  list: () => ["scheduledTasks", "list"] as const,
};

export function scheduledTasksListQueryOptions() {
  return queryOptions({
    queryKey: scheduledTasksQueryKeys.list(),
    queryFn: async () => {
      const api = ensureLocalApi();
      return api.scheduledTasks.list();
    },
    staleTime: 5000,
    refetchInterval: 12_000,
    refetchOnWindowFocus: true,
  });
}

export function scheduledTasksCreateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      name: string;
      prompt: string;
      cronExpression: string;
      workspacePath: string;
      model: string;
    }) => {
      const api = ensureLocalApi();
      return api.scheduledTasks.create(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduledTasksQueryKeys.all });
    },
  });
}

export function scheduledTasksUpdateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: ScheduledTaskUpdateInput) => {
      const api = ensureLocalApi();
      return api.scheduledTasks.update(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduledTasksQueryKeys.all });
    },
  });
}

export function scheduledTasksDeleteMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      const api = ensureLocalApi();
      return api.scheduledTasks.remove(id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduledTasksQueryKeys.all });
    },
  });
}

export function scheduledTasksToggleMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const api = ensureLocalApi();
      return api.scheduledTasks.toggle(id, enabled);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduledTasksQueryKeys.all });
    },
  });
}
