import {
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  HomeIcon,
  SearchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceProject } from "@t3tools/contracts";
import {
  workspaceCreateMutationOptions,
  workspaceDiscoverQueryOptions,
  workspaceSwitchMutationOptions,
} from "~/lib/workspaceReactQuery";

interface WorkspacePickerProps {
  readonly currentWorkspace?: string;
}

export function WorkspacePicker({ currentWorkspace }: WorkspacePickerProps) {
  const queryClient = useQueryClient();
  const discoverQuery = useQuery(workspaceDiscoverQueryOptions());
  const createMutation = useMutation(workspaceCreateMutationOptions(queryClient));
  const switchMutation = useMutation(workspaceSwitchMutationOptions());

  const projects: readonly WorkspaceProject[] = discoverQuery.data?.projects ?? [];
  const homeDir = discoverQuery.data?.homeDir ?? "~";

  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");

  const filtered = useMemo(() => {
    if (!search) return projects;
    const lower = search.toLowerCase();
    return projects.filter(
      (p) => p.name.toLowerCase().includes(lower) || p.path.toLowerCase().includes(lower),
    );
  }, [projects, search]);

  const handleCreate = () => {
    if (!newName.trim()) return;
    createMutation.mutate(newName.trim());
    setNewName("");
    setShowCreate(false);
  };

  const handleSwitch = (path: string) => {
    switchMutation.mutate(path);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search workspaces..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-3 text-sm"
        />
      </div>

      <div className="flex max-h-[300px] flex-col gap-0.5 overflow-y-auto">
        {filtered.map((project) => (
          <button
            key={project.path}
            type="button"
            onClick={() => handleSwitch(project.path)}
            className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${
              project.path === currentWorkspace
                ? "bg-primary/10 text-primary"
                : "text-foreground hover:bg-accent"
            }`}
          >
            {project.isHome ? (
              <HomeIcon className="size-4 shrink-0 text-primary" />
            ) : (
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{project.name}</span>
                {project.path === currentWorkspace && (
                  <span className="rounded bg-primary/20 px-1 py-0.5 text-[10px] text-primary">
                    active
                  </span>
                )}
              </div>
              <span className="block truncate text-[11px] text-muted-foreground">
                {project.path.replace(homeDir, "~")}
              </span>
            </div>
          </button>
        ))}

        {discoverQuery.isLoading && (
          <div className="py-4 text-center text-xs text-muted-foreground">
            Discovering projects...
          </div>
        )}
      </div>

      {showCreate ? (
        <div className="flex gap-2 border-t border-border pt-2">
          <input
            type="text"
            placeholder="Project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
            autoFocus
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={createMutation.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {createMutation.isPending ? "..." : "Create"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 border-t border-border pt-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <FolderPlusIcon className="size-3.5" />
          New project
        </button>
      )}
    </div>
  );
}
