"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  FolderOpen,
  FolderPlus,
  Files,
  Inbox,
  ChevronRight,
  Trash2,
  Pencil,
} from "lucide-react";

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  creator_id: string;
}

interface FolderSidebarProps {
  folders: Folder[];
  creatorId: string;
  activeFolder: string | null; // null = "All Files", "uncategorized" = no folder
  onSelect: (folderId: string | null) => void;
  fileCounts: Map<string, number>;
  totalCount: number;
  uncategorizedCount: number;
  onFoldersChanged: () => void;
}

function buildTree(folders: Folder[], parentId: string | null = null): (Folder & { children: Folder[] })[] {
  return folders
    .filter((f) => f.parent_id === parentId)
    .map((f) => ({ ...f, children: buildTree(folders, f.id) as never }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function FolderItem({
  folder,
  folders,
  depth,
  activeFolder,
  onSelect,
  fileCounts,
  onDelete,
  onRename,
}: {
  folder: Folder & { children: Folder[] };
  folders: Folder[];
  depth: number;
  activeFolder: string | null;
  onSelect: (id: string) => void;
  fileCounts: Map<string, number>;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const count = fileCounts.get(folder.id) ?? 0;
  const children = buildTree(folders, folder.id);
  const isActive = activeFolder === folder.id;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer text-sm transition-colors ${
          isActive
            ? "bg-primary/10 text-primary font-medium"
            : "hover:bg-muted text-foreground"
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onSelect(folder.id)}
      >
        {children.length > 0 ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="shrink-0"
          >
            <ChevronRight
              className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        ) : (
          <span className="w-3.5" />
        )}
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate flex-1">{folder.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {count}
        </span>
        <div className="hidden group-hover:flex items-center gap-0.5 ml-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              const newName = prompt("Rename folder:", folder.name);
              if (newName && newName !== folder.name) onRename(folder.id, newName);
            }}
            className="p-0.5 rounded hover:bg-muted-foreground/20"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete folder "${folder.name}"? Files will be moved to Uncategorized.`))
                onDelete(folder.id);
            }}
            className="p-0.5 rounded hover:bg-destructive/20 text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      {expanded &&
        children.map((child) => (
          <FolderItem
            key={child.id}
            folder={child as Folder & { children: Folder[] }}
            folders={folders}
            depth={depth + 1}
            activeFolder={activeFolder}
            onSelect={onSelect}
            fileCounts={fileCounts}
            onDelete={onDelete}
            onRename={onRename}
          />
        ))}
    </div>
  );
}

export function FolderSidebar({
  folders,
  creatorId,
  activeFolder,
  onSelect,
  fileCounts,
  totalCount,
  uncategorizedCount,
  onFoldersChanged,
}: FolderSidebarProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const tree = buildTree(folders);

  async function handleCreate() {
    if (!newName.trim()) return;
    await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), creatorId }),
    });
    setNewName("");
    setCreating(false);
    onFoldersChanged();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/folders/${id}`, { method: "DELETE" });
    onFoldersChanged();
  }

  async function handleRename(id: string, name: string) {
    await fetch(`/api/folders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    onFoldersChanged();
  }

  const navItem = (
    label: string,
    icon: React.ReactNode,
    count: number,
    folderId: string | null,
    key: string
  ) => (
    <button
      key={key}
      onClick={() => onSelect(folderId)}
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm w-full transition-colors ${
        activeFolder === folderId
          ? "bg-primary/10 text-primary font-medium"
          : "hover:bg-muted text-foreground"
      }`}
    >
      {icon}
      <span className="flex-1 text-left truncate">{label}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
    </button>
  );

  // Desktop sidebar
  const sidebarContent = (
    <div className="space-y-0.5">
      {navItem("All Files", <Files className="h-4 w-4 shrink-0" />, totalCount, null, "all")}
      {tree.map((folder) => (
        <FolderItem
          key={folder.id}
          folder={folder as Folder & { children: Folder[] }}
          folders={folders}
          depth={0}
          activeFolder={activeFolder}
          onSelect={onSelect}
          fileCounts={fileCounts}
          onDelete={handleDelete}
          onRename={handleRename}
        />
      ))}
      {navItem(
        "Uncategorized",
        <Inbox className="h-4 w-4 shrink-0" />,
        uncategorizedCount,
        "uncategorized",
        "uncat"
      )}
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <div className="hidden md:block w-56 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Folders
          </span>
          <Dialog open={creating} onOpenChange={setCreating}>
            <DialogTrigger
              render={<Button variant="ghost" size="icon" className="h-6 w-6" />}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </DialogTrigger>
            <DialogContent className="sm:max-w-xs">
              <DialogHeader>
                <DialogTitle>New Folder</DialogTitle>
              </DialogHeader>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleCreate();
                }}
                className="flex gap-2"
              >
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Folder name"
                  autoFocus
                />
                <Button type="submit" disabled={!newName.trim()}>
                  Create
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
        {sidebarContent}
      </div>

      {/* Mobile: horizontal scrollable pills */}
      <div className="md:hidden flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-none">
        <button
          onClick={() => onSelect(null)}
          className={`shrink-0 px-3 py-1.5 rounded-full text-sm border transition-colors ${
            activeFolder === null
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-card border-border hover:bg-muted"
          }`}
        >
          All ({totalCount})
        </button>
        {folders
          .filter((f) => !f.parent_id)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((f) => (
            <button
              key={f.id}
              onClick={() => onSelect(f.id)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-sm border transition-colors ${
                activeFolder === f.id
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border hover:bg-muted"
              }`}
            >
              {f.name} ({fileCounts.get(f.id) ?? 0})
            </button>
          ))}
        <button
          onClick={() => onSelect("uncategorized")}
          className={`shrink-0 px-3 py-1.5 rounded-full text-sm border transition-colors ${
            activeFolder === "uncategorized"
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-card border-border hover:bg-muted"
          }`}
        >
          Uncategorized ({uncategorizedCount})
        </button>
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogTrigger
            render={
              <button className="shrink-0 px-3 py-1.5 rounded-full text-sm border border-dashed border-border hover:bg-muted transition-colors" />
            }
          >
            + Folder
          </DialogTrigger>
          <DialogContent className="sm:max-w-xs">
            <DialogHeader>
              <DialogTitle>New Folder</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleCreate();
              }}
              className="flex gap-2"
            >
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Folder name"
                autoFocus
              />
              <Button type="submit" disabled={!newName.trim()}>
                Create
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
