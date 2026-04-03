"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { FolderOpen, Inbox, Loader2 } from "lucide-react";
import type { Folder } from "@/components/folder-sidebar";

function buildTree(
  folders: Folder[],
  parentId: string | null = null
): (Folder & { children: Folder[] })[] {
  return folders
    .filter((f) => f.parent_id === parentId)
    .map((f) => ({ ...f, children: buildTree(folders, f.id) as never }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function FolderOption({
  folder,
  folders,
  depth,
  selected,
  onSelect,
}: {
  folder: Folder;
  folders: Folder[];
  depth: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const children = buildTree(folders, folder.id);
  return (
    <>
      <button
        onClick={() => onSelect(folder.id)}
        className={`flex items-center gap-2 w-full px-3 py-2 text-sm rounded-md transition-colors ${
          selected === folder.id
            ? "bg-primary/10 text-primary font-medium"
            : "hover:bg-muted"
        }`}
        style={{ paddingLeft: `${12 + depth * 20}px` }}
      >
        <FolderOpen className="h-4 w-4 shrink-0" />
        <span className="truncate">{folder.name}</span>
      </button>
      {children.map((child) => (
        <FolderOption
          key={child.id}
          folder={child}
          folders={folders}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function MoveDialog({
  open,
  onOpenChange,
  folders,
  selectedCount,
  onMove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: Folder[];
  selectedCount: number;
  onMove: (folderId: string | null) => Promise<void>;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const tree = buildTree(folders);

  async function handleMove() {
    setMoving(true);
    await onMove(target);
    setMoving(false);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            Move {selectedCount} {selectedCount === 1 ? "file" : "files"}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-64 overflow-y-auto space-y-0.5 -mx-2 px-2">
          <button
            onClick={() => setTarget(null)}
            className={`flex items-center gap-2 w-full px-3 py-2 text-sm rounded-md transition-colors ${
              target === null
                ? "bg-primary/10 text-primary font-medium"
                : "hover:bg-muted"
            }`}
          >
            <Inbox className="h-4 w-4 shrink-0" />
            <span>Uncategorized</span>
          </button>
          {tree.map((folder) => (
            <FolderOption
              key={folder.id}
              folder={folder}
              folders={folders}
              depth={0}
              selected={target}
              onSelect={setTarget}
            />
          ))}
        </div>
        <DialogFooter>
          <Button onClick={handleMove} disabled={moving}>
            {moving ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
