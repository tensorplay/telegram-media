"use client";

import { useMemo, useState } from "react";
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
  Camera,
  Layers,
  Megaphone,
  Archive,
  Star,
} from "lucide-react";
import { CHANNELS, parseTags, type ChannelValue } from "@/lib/facets";
import type { MediaItem } from "@/components/media-grid";

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  creator_id: string;
}

export type ActiveSelection =
  | { kind: "all" }
  | { kind: "inbox" }
  | { kind: "heroes" }
  | { kind: "archive" }
  | { kind: "shoots" }
  | { kind: "shoot"; slug: string }
  | { kind: "campaigns" }
  | { kind: "folder"; id: string }
  | { kind: "channel"; channel: ChannelValue };

export function selectionsEqual(a: ActiveSelection, b: ActiveSelection) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "folder" && b.kind === "folder") return a.id === b.id;
  if (a.kind === "shoot" && b.kind === "shoot") return a.slug === b.slug;
  if (a.kind === "channel" && b.kind === "channel") return a.channel === b.channel;
  return true;
}

interface LibraryNavProps {
  folders: Folder[];
  creatorId: string;
  active: ActiveSelection;
  onSelect: (sel: ActiveSelection) => void;
  media: MediaItem[];
  onFoldersChanged: () => void;
  shootNames: { slug: string; name: string; count: number }[];
}

function buildTree(
  folders: Folder[],
  parentId: string | null = null
): (Folder & { children: Folder[] })[] {
  return folders
    .filter((f) => f.parent_id === parentId)
    .map((f) => ({ ...f, children: buildTree(folders, f.id) as never }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function FolderItem({
  folder,
  folders,
  depth,
  active,
  onSelect,
  fileCounts,
  onDelete,
  onRename,
}: {
  folder: Folder & { children: Folder[] };
  folders: Folder[];
  depth: number;
  active: ActiveSelection;
  onSelect: (sel: ActiveSelection) => void;
  fileCounts: Map<string, number>;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const count = fileCounts.get(folder.id) ?? 0;
  const children = buildTree(folders, folder.id);
  const isActive = active.kind === "folder" && active.id === folder.id;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer text-sm transition-colors ${
          isActive
            ? "bg-primary/10 text-primary font-medium"
            : "hover:bg-muted text-foreground"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => onSelect({ kind: "folder", id: folder.id })}
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
              className={`h-3.5 w-3.5 transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
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
              if (
                confirm(
                  `Delete folder "${folder.name}"? Files will be moved to Uncategorized.`
                )
              )
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
            active={active}
            onSelect={onSelect}
            fileCounts={fileCounts}
            onDelete={onDelete}
            onRename={onRename}
          />
        ))}
    </div>
  );
}

export function LibraryNav({
  folders,
  creatorId,
  active,
  onSelect,
  media,
  onFoldersChanged,
  shootNames,
}: LibraryNavProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [sectionsOpen, setSectionsOpen] = useState<Record<string, boolean>>({
    library: true,
    shoots: true,
    channels: false,
    campaigns: true,
  });

  // Compute counts off the parsed media once.
  const counts = useMemo(() => {
    const fileCounts = new Map<string, number>();
    let inbox = 0;
    let heroes = 0;
    let archive = 0;
    const byChannel = new Map<ChannelValue, number>();
    const now = Date.now();
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

    for (const m of media) {
      if (m.folder_id) {
        fileCounts.set(m.folder_id, (fileCounts.get(m.folder_id) ?? 0) + 1);
      }
      const { system } = parseTags(m.ai_tags);
      if (system.hero) heroes++;
      // Inbox = no AI tags yet OR raw status OR uncategorized and untagged.
      const hasAnyTag = (m.ai_tags?.length ?? 0) > 0;
      if (
        !hasAnyTag ||
        system.statuses.includes("raw") ||
        (!m.folder_id && system.statuses.length === 0)
      ) {
        inbox++;
      }
      if (
        system.statuses.length === 0 &&
        now - new Date(m.created_at).getTime() > NINETY_DAYS
      ) {
        archive++;
      }
      for (const c of system.channels) {
        byChannel.set(c, (byChannel.get(c) ?? 0) + 1);
      }
    }

    return { fileCounts, inbox, heroes, archive, byChannel };
  }, [media]);

  const tree = buildTree(folders);
  const campaignsRoot = tree.find((f) => f.name.toLowerCase() === "campaigns");
  const nonCampaignFolders = tree.filter(
    (f) => f.name.toLowerCase() !== "campaigns"
  );

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

  function toggleSection(key: string) {
    setSectionsOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const Section = ({
    id,
    label,
    children,
    action,
  }: {
    id: string;
    label: string;
    children: React.ReactNode;
    action?: React.ReactNode;
  }) => {
    const open = sectionsOpen[id] ?? true;
    return (
      <div className="mb-2">
        <div className="flex items-center justify-between pr-1">
          <button
            onClick={() => toggleSection(id)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground"
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${
                open ? "rotate-90" : ""
              }`}
            />
            {label}
          </button>
          {action}
        </div>
        {open && <div className="space-y-0.5">{children}</div>}
      </div>
    );
  };

  const NavButton = ({
    icon,
    label,
    count,
    onClick,
    isActive,
  }: {
    icon: React.ReactNode;
    label: string;
    count?: number;
    onClick: () => void;
    isActive: boolean;
  }) => (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm transition-colors ${
        isActive
          ? "bg-primary/10 text-primary font-medium"
          : "hover:bg-muted text-foreground"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 text-left truncate">{label}</span>
      {count !== undefined && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </button>
  );

  const sidebar = (
    <>
      <Section id="library" label="Library">
        <NavButton
          icon={<Files className="h-4 w-4" />}
          label="All Files"
          count={media.length}
          onClick={() => onSelect({ kind: "all" })}
          isActive={active.kind === "all"}
        />
        <NavButton
          icon={<Inbox className="h-4 w-4" />}
          label="Inbox"
          count={counts.inbox}
          onClick={() => onSelect({ kind: "inbox" })}
          isActive={active.kind === "inbox"}
        />
        <NavButton
          icon={<Star className="h-4 w-4" />}
          label="Heroes"
          count={counts.heroes}
          onClick={() => onSelect({ kind: "heroes" })}
          isActive={active.kind === "heroes"}
        />
        <NavButton
          icon={<Archive className="h-4 w-4" />}
          label="Archive"
          count={counts.archive}
          onClick={() => onSelect({ kind: "archive" })}
          isActive={active.kind === "archive"}
        />
      </Section>

      <Section id="shoots" label="Shoots">
        <NavButton
          icon={<Camera className="h-4 w-4" />}
          label="All shoots"
          count={shootNames.length}
          onClick={() => onSelect({ kind: "shoots" })}
          isActive={active.kind === "shoots"}
        />
        {shootNames.slice(0, 12).map((s) => (
          <button
            key={s.slug}
            onClick={() => onSelect({ kind: "shoot", slug: s.slug })}
            className={`flex items-center gap-2 w-full pl-5 pr-2 py-1 rounded-md text-xs transition-colors ${
              active.kind === "shoot" && active.slug === s.slug
                ? "bg-primary/10 text-primary font-medium"
                : "hover:bg-muted text-muted-foreground"
            }`}
            title={s.name}
          >
            <span className="flex-1 text-left truncate">{s.name}</span>
            <span className="tabular-nums shrink-0">{s.count}</span>
          </button>
        ))}
      </Section>

      <Section id="channels" label="Channels">
        {CHANNELS.map((c) => (
          <NavButton
            key={c.value}
            icon={<Layers className="h-4 w-4" />}
            label={c.label}
            count={counts.byChannel.get(c.value) ?? 0}
            onClick={() => onSelect({ kind: "channel", channel: c.value })}
            isActive={active.kind === "channel" && active.channel === c.value}
          />
        ))}
      </Section>

      <Section
        id="campaigns"
        label="Campaigns"
        action={
          <Dialog open={creating} onOpenChange={setCreating}>
            <DialogTrigger>
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <FolderPlus className="h-3.5 w-3.5" />
              </Button>
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
                  placeholder="Folder name (e.g. Campaigns, Nike Fall 2026)"
                  autoFocus
                />
                <Button type="submit" disabled={!newName.trim()}>
                  Create
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        }
      >
        <NavButton
          icon={<Megaphone className="h-4 w-4" />}
          label="All campaigns"
          onClick={() => onSelect({ kind: "campaigns" })}
          isActive={active.kind === "campaigns"}
        />
        {campaignsRoot &&
          buildTree(folders, campaignsRoot.id).map((folder) => (
            <FolderItem
              key={folder.id}
              folder={folder as Folder & { children: Folder[] }}
              folders={folders}
              depth={0}
              active={active}
              onSelect={onSelect}
              fileCounts={counts.fileCounts}
              onDelete={handleDelete}
              onRename={handleRename}
            />
          ))}
        {nonCampaignFolders.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border/40">
            <p className="px-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
              Other folders
            </p>
            {nonCampaignFolders.map((folder) => (
              <FolderItem
                key={folder.id}
                folder={folder as Folder & { children: Folder[] }}
                folders={folders}
                depth={0}
                active={active}
                onSelect={onSelect}
                fileCounts={counts.fileCounts}
                onDelete={handleDelete}
                onRename={handleRename}
              />
            ))}
          </div>
        )}
      </Section>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <div className="hidden md:block w-60 shrink-0">{sidebar}</div>

      {/* Mobile: horizontal pills for the most-used destinations */}
      <div className="md:hidden flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-none">
        <MobilePill
          active={active.kind === "all"}
          onClick={() => onSelect({ kind: "all" })}
        >
          All ({media.length})
        </MobilePill>
        <MobilePill
          active={active.kind === "inbox"}
          onClick={() => onSelect({ kind: "inbox" })}
        >
          Inbox ({counts.inbox})
        </MobilePill>
        <MobilePill
          active={active.kind === "heroes"}
          onClick={() => onSelect({ kind: "heroes" })}
        >
          Heroes ({counts.heroes})
        </MobilePill>
        <MobilePill
          active={active.kind === "shoots"}
          onClick={() => onSelect({ kind: "shoots" })}
        >
          Shoots ({shootNames.length})
        </MobilePill>
        {CHANNELS.slice(0, 3).map((c) => (
          <MobilePill
            key={c.value}
            active={active.kind === "channel" && active.channel === c.value}
            onClick={() => onSelect({ kind: "channel", channel: c.value })}
          >
            {c.label} ({counts.byChannel.get(c.value) ?? 0})
          </MobilePill>
        ))}
      </div>
    </>
  );
}

function MobilePill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 px-3 py-1.5 rounded-full text-sm border transition-colors ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-card border-border hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}
