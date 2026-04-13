import { queryOptions, mutationOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const workspaceQueryKeys = {
  all: ["workspace"] as const,
  discover: () => ["workspace", "discover"] as const,
};

export function workspaceDiscoverQueryOptions() {
  return queryOptions({
    queryKey: workspaceQueryKeys.discover(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.workspace.discover();
    },
    staleTime: 30000,
  });
}

export function workspaceCreateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (name: string) => {
      const api = ensureNativeApi();
      return api.workspace.create(name);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
    },
  });
}

export function workspaceSwitchMutationOptions() {
  return mutationOptions({
    mutationFn: async (path: string) => {
      const api = ensureNativeApi();
      return api.workspace.switchTo(path);
    },
  });
}
