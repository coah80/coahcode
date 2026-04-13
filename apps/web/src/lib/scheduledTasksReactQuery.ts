import { queryOptions, mutationOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const scheduledTasksQueryKeys = {
  all: ["scheduledTasks"] as const,
  list: () => ["scheduledTasks", "list"] as const,
};

export function scheduledTasksListQueryOptions() {
  return queryOptions({
    queryKey: scheduledTasksQueryKeys.list(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.scheduledTasks.list();
    },
    staleTime: 5000,
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
      const api = ensureNativeApi();
      return api.scheduledTasks.create(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduledTasksQueryKeys.all });
    },
  });
}

export function scheduledTasksDeleteMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      const api = ensureNativeApi();
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
      const api = ensureNativeApi();
      return api.scheduledTasks.toggle(id, enabled);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduledTasksQueryKeys.all });
    },
  });
}
