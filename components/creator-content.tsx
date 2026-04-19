"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MediaSearch } from "@/components/media-search";
import { MediaGrid, type MediaItem } from "@/components/media-grid";
import { UploadDropzone } from "@/components/upload-dropzone";
import { FolderSidebar, type Folder } from "@/components/folder-sidebar";
import { MoveDialog } from "@/components/move-dialog";
import { CleanupTagsDialog } from "@/components/cleanup-tags-dialog";
import { TagFilter } from "@/components/tag-filter";
import { Button } from "@/components/ui/button";
import { CheckSquare, X, FolderInput, Sparkles, Wand2 } from "lucide-react";

export function CreatorContent({
  creatorSlug,
  creatorId,
  media,
  initialFolders,
}: {
  creatorSlug: string;
  creatorId: string;
  media: (MediaItem & { folder_id?: string | null })[];
  initialFolders: Folder[];
}) {
  const [folders, setFolders] = useState<Folder[]>(initialFolders);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [searchIds, setSearchIds] = useState<string[] | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [includeTags, setIncludeTags] = useState<Set<string>>(new Set());
  const [excludeTags, setExcludeTags] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<
    { folderName: string; mediaIds: string[]; count: number }[]
  >([]);

  useEffect(() => {
    fetch(`/api/suggest-folders?creatorId=${creatorId}`)
      .then((r) => r.json())
      .then((d) => setSuggestions(d.suggestions ?? []))
      .catch(() => {});
  }, [creatorId]);

  const refreshFolders = useCallback(async () => {
    const res = await fetch(`/api/folders?creatorId=${creatorId}`);
    if (res.ok) {
      const { folders: f } = await res.json();
      setFolders(f);
    }
  }, [creatorId]);

  // Compute counts
  const fileCounts = useMemo(() => {
    const map = new Map<string, number>();
    media.forEach((m) => {
      if (m.folder_id) {
        map.set(m.folder_id, (map.get(m.folder_id) ?? 0) + 1);
      }
    });
    return map;
  }, [media]);

  const uncategorizedCount = media.filter((m) => !m.folder_id).length;

  // Filter by folder
  const folderFiltered = useMemo(() => {
    if (activeFolder === null) return media;
    if (activeFolder === "uncategorized") return media.filter((m) => !m.folder_id);

    const folderIds = new Set<string>();
    function collectChildren(parentId: string) {
      folderIds.add(parentId);
      folders.filter((f) => f.parent_id === parentId).forEach((f) => collectChildren(f.id));
    }
    collectChildren(activeFolder);
    return media.filter((m) => m.folder_id && folderIds.has(m.folder_id));
  }, [media, activeFolder, folders]);

  // Apply search filter on top
  const searchFiltered = useMemo(() => {
    if (searchIds === null) return folderFiltered;
    const idSet = new Set(searchIds);
    return folderFiltered.filter((m) => idSet.has(m.id));
  }, [folderFiltered, searchIds]);

  // Apply tag filter on top of folder + search
  const displayMedia = useMemo(() => {
    if (includeTags.size === 0 && excludeTags.size === 0) return searchFiltered;
    return searchFiltered.filter((m) => {
      const tags = new Set(m.ai_tags ?? []);
      for (const t of includeTags) if (!tags.has(t)) return false;
      for (const t of excludeTags) if (tags.has(t)) return false;
      return true;
    });
  }, [searchFiltered, includeTags, excludeTags]);

  // All distinct tags across the creator's media, with counts, for the filter panel.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    media.forEach((m) =>
      m.ai_tags?.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1))
    );
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [media]);

  const setTagMode = useCallback(
    (tag: string, mode: "include" | "exclude" | "neutral") => {
      setIncludeTags((inc) => {
        const next = new Set(inc);
        if (mode === "include") next.add(tag);
        else next.delete(tag);
        return next;
      });
      setExcludeTags((exc) => {
        const next = new Set(exc);
        if (mode === "exclude") next.add(tag);
        else next.delete(tag);
        return next;
      });
    },
    []
  );

  const cycleTag = useCallback(
    (tag: string) => {
      if (includeTags.has(tag)) setTagMode(tag, "exclude");
      else if (excludeTags.has(tag)) setTagMode(tag, "neutral");
      else setTagMode(tag, "include");
    },
    [includeTags, excludeTags, setTagMode]
  );

  const removeTag = useCallback(
    (tag: string) => setTagMode(tag, "neutral"),
    [setTagMode]
  );

  const clearTagFilters = useCallback(() => {
    setIncludeTags(new Set());
    setExcludeTags(new Set());
  }, []);

  const handleTileTagClick = useCallback(
    (tag: string, exclude: boolean) => {
      setTagMode(tag, exclude ? "exclude" : "include");
    },
    [setTagMode]
  );

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelection() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  async function handleMove(folderId: string | null) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    await fetch("/api/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaIds: ids, folderId }),
    });
    exitSelection();
    window.location.reload();
  }

  return (
    <div className="flex gap-6">
      <FolderSidebar
        folders={folders}
        creatorId={creatorId}
        activeFolder={activeFolder}
        onSelect={setActiveFolder}
        fileCounts={fileCounts}
        totalCount={media.length}
        uncategorizedCount={uncategorizedCount}
        onFoldersChanged={() => {
          refreshFolders();
          window.location.reload();
        }}
      />

      <div className="flex-1 min-w-0">
        <div className="flex gap-2 mb-4">
          <div className="flex-1">
            <MediaSearch
              creatorId={creatorId}
              onResults={(ids) => setSearchIds(ids)}
              onClear={() => setSearchIds(null)}
            />
          </div>
        </div>

        <TagFilter
          allTags={allTags}
          includeTags={includeTags}
          excludeTags={excludeTags}
          onCycle={cycleTag}
          onRemove={removeTag}
          onClear={clearTagFilters}
        />

        {/* Selection toolbar */}
        {selectionMode ? (
          <div className="flex flex-wrap items-center gap-2 mb-4 p-2 rounded-lg border bg-muted/50">
            <span className="text-sm font-medium">
              {selectedIds.size} selected
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const visibleIds = displayMedia.map((m) => m.id);
                const allSelected =
                  visibleIds.length > 0 &&
                  visibleIds.every((id) => selectedIds.has(id));
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  if (allSelected) {
                    visibleIds.forEach((id) => next.delete(id));
                  } else {
                    visibleIds.forEach((id) => next.add(id));
                  }
                  return next;
                });
              }}
              disabled={displayMedia.length === 0}
            >
              <CheckSquare className="h-3.5 w-3.5 mr-1.5" />
              {displayMedia.length > 0 &&
              displayMedia.every((m) => selectedIds.has(m.id))
                ? `Deselect all (${displayMedia.length})`
                : `Select all (${displayMedia.length})`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={selectedIds.size === 0}
              onClick={() => setMoveOpen(true)}
            >
              <FolderInput className="h-3.5 w-3.5 mr-1.5" />
              Move to...
            </Button>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={exitSelection}>
              <X className="h-3.5 w-3.5 mr-1" />
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 mb-4">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelectionMode(true)}
            >
              <CheckSquare className="h-3.5 w-3.5 mr-1.5" />
              Select
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCleanupOpen(true)}
            >
              <Wand2 className="h-3.5 w-3.5 mr-1.5" />
              Clean up tags
            </Button>
          </div>
        )}

        {/* AI suggestions banner */}
        {suggestions.length > 0 && (
          <div className="mb-4 p-3 rounded-lg border border-primary/20 bg-primary/5">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">AI Folder Suggestions</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.folderName}
                  onClick={async () => {
                    const res = await fetch("/api/folders", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        name: s.folderName,
                        creatorId,
                      }),
                    });
                    if (!res.ok) return;
                    const { folder } = await res.json();
                    await fetch("/api/move", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        mediaIds: s.mediaIds,
                        folderId: folder.id,
                      }),
                    });
                    setSuggestions((prev) =>
                      prev.filter((p) => p.folderName !== s.folderName)
                    );
                    refreshFolders();
                    window.location.reload();
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-full border border-primary/30 bg-white dark:bg-neutral-900 hover:bg-primary/10 transition-colors"
                >
                  Create &ldquo;{s.folderName}&rdquo;
                  <span className="text-xs text-muted-foreground">
                    ({s.count} files)
                  </span>
                </button>
              ))}
              <button
                onClick={() => setSuggestions([])}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <UploadDropzone creatorSlug={creatorSlug} creatorId={creatorId} />

        <div className="mt-2">
          {(searchIds !== null ||
            includeTags.size > 0 ||
            excludeTags.size > 0) && (
            <p className="text-sm text-muted-foreground mb-2">
              Showing {displayMedia.length} of {media.length} results
            </p>
          )}
          <MediaGrid
            media={displayMedia}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onTagClick={handleTileTagClick}
          />
        </div>
      </div>

      <MoveDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        folders={folders}
        selectedCount={selectedIds.size}
        onMove={handleMove}
      />

      <CleanupTagsDialog
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        creatorId={creatorId}
      />
    </div>
  );
}
