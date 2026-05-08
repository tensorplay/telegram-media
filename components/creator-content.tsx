"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MediaSearch } from "@/components/media-search";
import {
  MediaGrid,
  type MediaItem,
  type MediaGridHandle,
} from "@/components/media-grid";
import { UploadDropzone } from "@/components/upload-dropzone";
import {
  LibraryNav,
  selectionsEqual,
  type ActiveSelection,
  type Folder,
} from "@/components/library-nav";
import { CleanupTagsDialog } from "@/components/cleanup-tags-dialog";
import { TagFilter } from "@/components/tag-filter";
import { InspectorPanel } from "@/components/inspector-panel";
import { ShootsView } from "@/components/shoots-view";
import { GridPlanner } from "@/components/grid-planner";
import { BurstCullDialog } from "@/components/burst-cull";
import { TriageWizard } from "@/components/triage-wizard";
import { Button } from "@/components/ui/button";
import {
  CheckSquare,
  X,
  Sparkles,
  Wand2,
  LayoutGrid,
  Camera,
  Keyboard,
  Info,
  Layers,
  Loader2,
} from "lucide-react";
import { clusterShoots } from "@/lib/shoots";
import {
  CHANNELS,
  parseTags,
  primaryStatus,
  slugify,
  STATUS_LABELS,
  type ChannelValue,
  type StatusValue,
} from "@/lib/facets";

type Media = MediaItem & { folder_id?: string | null };
type ViewMode = "shoots" | "grid" | "planner";

interface ShootSuggestion {
  slug: string;
  name: string;
  count: number;
  topTags: string[];
  mediaIds: string[];
  startsAt: string;
  endsAt: string;
}

interface CollectionSuggestion {
  name: string;
  description: string;
  requireTags: string[];
  count: number;
  mediaIds: string[];
}

export function CreatorContent({
  creatorSlug,
  creatorId,
  media,
  initialFolders,
}: {
  creatorSlug: string;
  creatorId: string;
  media: Media[];
  initialFolders: Folder[];
}) {
  const [folders, setFolders] = useState<Folder[]>(initialFolders);
  const [active, setActive] = useState<ActiveSelection>({ kind: "all" });
  const [searchIds, setSearchIds] = useState<string[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [includeTags, setIncludeTags] = useState<Set<string>>(new Set());
  const [excludeTags, setExcludeTags] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<{
    shoots: ShootSuggestion[];
    collections: CollectionSuggestion[];
  }>({ shoots: [], collections: [] });
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("shoots");
  const [showVariants, setShowVariants] = useState(false);
  const [keyboardHelpOpen, setKeyboardHelpOpen] = useState(false);
  const [burstItems, setBurstItems] = useState<MediaItem[] | null>(null);
  const [pendingTriage, setPendingTriage] = useState<MediaItem[] | null>(null);
  const [suggestionBusy, setSuggestionBusy] = useState<string | null>(null);
  const gridRef = useRef<MediaGridHandle>(null);

  useEffect(() => {
    fetch(`/api/suggest-folders?creatorId=${creatorId}`)
      .then((r) => r.json())
      .then((d) =>
        setSuggestions({
          shoots: d.shoots ?? [],
          collections: d.collections ?? [],
        })
      )
      .catch(() => {});
  }, [creatorId]);

  const refresh = useCallback(() => {
    // Full reload covers both folder and media mutations. The page is a
    // server component, so SSR data comes back fresh.
    window.location.reload();
  }, []);

  const refreshFolders = useCallback(async () => {
    const res = await fetch(`/api/folders?creatorId=${creatorId}`);
    if (res.ok) {
      const { folders: f } = await res.json();
      setFolders(f);
    }
  }, [creatorId]);

  // Tag counts across the whole library — used for distinctive-tag picking
  // and the facet filter dropdown.
  const tagCounts = useMemo(() => {
    const map = new Map<string, number>();
    media.forEach((m) =>
      m.ai_tags?.forEach((t) => {
        const k = t.trim().toLowerCase();
        if (!k) return;
        map.set(k, (map.get(k) ?? 0) + 1);
      })
    );
    return map;
  }, [media]);

  const allShoots = useMemo(() => clusterShoots(media), [media]);
  const shootNames = useMemo(
    () =>
      allShoots
        .filter((s) => s.promoted)
        .map((s) => ({ slug: s.slug, name: s.name, count: s.items.length })),
    [allShoots]
  );

  // ------- Filter pipeline ----------------------------------------------
  // Library section filter
  const sectionFiltered = useMemo(() => {
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    switch (active.kind) {
      case "all":
        return media;
      case "inbox":
        return media.filter((m) => {
          const { system } = parseTags(m.ai_tags);
          const hasAnyTag = (m.ai_tags?.length ?? 0) > 0;
          return (
            !hasAnyTag ||
            system.statuses.includes("raw") ||
            (!m.folder_id && system.statuses.length === 0)
          );
        });
      case "heroes":
        return media.filter((m) => parseTags(m.ai_tags).system.hero);
      case "archive":
        return media.filter((m) => {
          const { system } = parseTags(m.ai_tags);
          return (
            system.statuses.length === 0 &&
            now - new Date(m.created_at).getTime() > NINETY_DAYS
          );
        });
      case "shoots":
        return media;
      case "shoot":
        return media.filter(
          (m) => parseTags(m.ai_tags).system.shoot === active.slug
        );
      case "channel":
        return media.filter((m) =>
          parseTags(m.ai_tags).system.channels.includes(active.channel)
        );
      case "folder": {
        const folderIds = new Set<string>();
        function collect(parentId: string) {
          folderIds.add(parentId);
          folders
            .filter((f) => f.parent_id === parentId)
            .forEach((f) => collect(f.id));
        }
        collect(active.id);
        return media.filter((m) => m.folder_id && folderIds.has(m.folder_id));
      }
      case "campaigns": {
        const root = folders.find((f) => f.name.toLowerCase() === "campaigns");
        if (!root) return [];
        const folderIds = new Set<string>();
        function collect(parentId: string) {
          folderIds.add(parentId);
          folders
            .filter((f) => f.parent_id === parentId)
            .forEach((f) => collect(f.id));
        }
        collect(root.id);
        return media.filter((m) => m.folder_id && folderIds.has(m.folder_id));
      }
    }
  }, [active, media, folders]);

  const searchFiltered = useMemo(() => {
    if (searchIds === null) return sectionFiltered;
    const idSet = new Set(searchIds);
    return sectionFiltered.filter((m) => idSet.has(m.id));
  }, [sectionFiltered, searchIds]);

  const displayMedia = useMemo(() => {
    if (includeTags.size === 0 && excludeTags.size === 0) return searchFiltered;
    return searchFiltered.filter((m) => {
      const tags = new Set(
        (m.ai_tags ?? []).map((t) =>
          typeof t === "string" ? t.toLowerCase() : ""
        )
      );
      for (const t of includeTags) if (!tags.has(t)) return false;
      for (const t of excludeTags) if (tags.has(t)) return false;
      return true;
    });
  }, [searchFiltered, includeTags, excludeTags]);

  const allTags = useMemo(() => {
    return Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [tagCounts]);

  const sectionShoots = useMemo(
    () => clusterShoots(displayMedia),
    [displayMedia]
  );

  // ------- Tag cycle helpers --------------------------------------------
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

  const handleTileTagClick = useCallback(
    (tag: string, exclude: boolean) => setTagMode(tag, exclude ? "exclude" : "include"),
    [setTagMode]
  );

  // ------- Selection helpers --------------------------------------------
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllInShoot = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allIn = ids.every((id) => next.has(id));
      if (allIn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setInspectorOpen(false);
  }, []);

  // ------- Quick-tag mutations (keyboard / per-tile) --------------------
  const quickApplyStatus = useCallback(
    async (id: string, status: StatusValue) => {
      await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaIds: [id],
          clearPrefixes: ["status:"],
          add: [`status:${status}`],
        }),
      });
      refresh();
    },
    [refresh]
  );

  const quickToggleHero = useCallback(
    async (id: string) => {
      const item = media.find((m) => m.id === id);
      if (!item) return;
      const { system } = parseTags(item.ai_tags);
      const body = system.hero
        ? { mediaIds: [id], remove: ["hero"] }
        : { mediaIds: [id], add: ["hero"], remove: ["variant"] };
      await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      refresh();
    },
    [media, refresh]
  );

  const openInspectorFor = useCallback(
    (id: string) => {
      setSelectedIds((prev) => {
        if (prev.size === 0) return new Set([id]);
        return prev;
      });
      setInspectorOpen(true);
    },
    []
  );

  const jumpToShoot = useCallback(
    (slug: string) => {
      setActive({ kind: "shoot", slug });
      setViewMode("grid");
    },
    []
  );

  // Keep active selection coherent if the underlying folders change.
  useEffect(() => {
    if (active.kind === "folder") {
      if (!folders.some((f) => f.id === active.id)) {
        setActive({ kind: "all" });
      }
    }
  }, [active, folders]);

  // Update inspector items as selection changes.
  const selectedItems = useMemo(
    () => media.filter((m) => selectedIds.has(m.id)),
    [media, selectedIds]
  );

  // Global keyboard shortcuts at the page level
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "?") {
        e.preventDefault();
        setKeyboardHelpOpen((v) => !v);
      }
      if (e.key === "Escape") {
        if (inspectorOpen) {
          setInspectorOpen(false);
        } else if (selectedIds.size > 0) {
          clearSelection();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspectorOpen, selectedIds.size, clearSelection]);

  // Auto-open inspector when selection becomes non-empty.
  useEffect(() => {
    if (selectedIds.size > 0) setInspectorOpen(true);
  }, [selectedIds.size]);

  // ------- Suggestion application ---------------------------------------
  async function applyShootSuggestion(s: ShootSuggestion) {
    setSuggestionBusy(`shoot:${s.slug}`);
    try {
      await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaIds: s.mediaIds,
          add: [`shoot:${s.slug}`],
          clearPrefixes: ["shoot:"],
        }),
      });
      setSuggestions((prev) => ({
        ...prev,
        shoots: prev.shoots.filter((x) => x.slug !== s.slug),
      }));
      refresh();
    } finally {
      setSuggestionBusy(null);
    }
  }

  async function applyCollectionSuggestion(c: CollectionSuggestion) {
    setSuggestionBusy(`col:${c.name}`);
    try {
      // Create a Campaigns parent folder lazily if it doesn't exist.
      let campaignsRoot = folders.find(
        (f) => f.name.toLowerCase() === "campaigns"
      );
      if (!campaignsRoot) {
        const res = await fetch("/api/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Campaigns", creatorId }),
        });
        if (res.ok) {
          const { folder } = await res.json();
          campaignsRoot = folder;
        }
      }
      const createRes = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: c.name,
          creatorId,
          parentId: campaignsRoot?.id,
        }),
      });
      if (!createRes.ok) return;
      const { folder } = await createRes.json();

      await fetch("/api/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaIds: c.mediaIds, folderId: folder.id }),
      });
      await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaIds: c.mediaIds,
          add: [`brand:${slugify(c.name)}`],
        }),
      });
      setSuggestions((prev) => ({
        ...prev,
        collections: prev.collections.filter((x) => x.name !== c.name),
      }));
      refresh();
    } finally {
      setSuggestionBusy(null);
    }
  }

  // ------- Render -------------------------------------------------------
  const headerLabel = useMemo(() => {
    switch (active.kind) {
      case "all":
        return "All files";
      case "inbox":
        return "Inbox — needs triage";
      case "heroes":
        return "Hero picks";
      case "archive":
        return "Archive — no lifecycle state & older than 90 days";
      case "shoots":
        return "All shoots";
      case "shoot":
        return shootNames.find((s) => s.slug === active.slug)?.name ??
          `Shoot — ${active.slug}`;
      case "channel":
        return `${CHANNELS.find((c) => c.value === active.channel)?.label}`;
      case "campaigns":
        return "Campaigns";
      case "folder":
        return folders.find((f) => f.id === active.id)?.name ?? "Folder";
    }
  }, [active, folders, shootNames]);

  // Whether to offer the planner toggle for this view.
  const canUsePlanner = active.kind === "channel";

  // Auto-switch view mode when switching sections where shoots don't make sense.
  useEffect(() => {
    if (
      active.kind === "channel" ||
      active.kind === "folder" ||
      active.kind === "campaigns"
    ) {
      setViewMode((m) => (m === "shoots" ? "grid" : m));
    }
  }, [active]);

  const filterPipelineHasAny =
    searchIds !== null || includeTags.size > 0 || excludeTags.size > 0;

  return (
    <div className="flex gap-6">
      <LibraryNav
        folders={folders}
        creatorId={creatorId}
        active={active}
        onSelect={(sel) => {
          if (!selectionsEqual(sel, active)) setActive(sel);
        }}
        media={media}
        onFoldersChanged={() => {
          refreshFolders();
          refresh();
        }}
        shootNames={shootNames}
      />

      <div className="flex-1 min-w-0">
        {/* Section header */}
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold">{headerLabel}</h2>
            <p className="text-xs text-muted-foreground">
              {displayMedia.length} file{displayMedia.length === 1 ? "" : "s"}
              {filterPipelineHasAny && ` · filtered from ${sectionFiltered.length}`}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {canUsePlanner && (
              <Button
                size="sm"
                variant={viewMode === "planner" ? "default" : "outline"}
                onClick={() =>
                  setViewMode((m) => (m === "planner" ? "grid" : "planner"))
                }
              >
                <Layers className="h-3.5 w-3.5 mr-1.5" />
                Planner
              </Button>
            )}
            <Button
              size="sm"
              variant={viewMode === "shoots" ? "default" : "outline"}
              onClick={() => setViewMode("shoots")}
              disabled={active.kind === "channel" || active.kind === "folder"}
              title="Group by shoot"
            >
              <Camera className="h-3.5 w-3.5 mr-1.5" />
              Shoots
            </Button>
            <Button
              size="sm"
              variant={viewMode === "grid" ? "default" : "outline"}
              onClick={() => setViewMode("grid")}
            >
              <LayoutGrid className="h-3.5 w-3.5 mr-1.5" />
              Grid
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setKeyboardHelpOpen((v) => !v)}
              title="Keyboard shortcuts"
            >
              <Keyboard className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Search */}
        <MediaSearch
          creatorId={creatorId}
          onResults={(ids) => setSearchIds(ids)}
          onClear={() => setSearchIds(null)}
        />

        {/* Tag filter + selection toolbar */}
        <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
          <TagFilter
            allTags={allTags}
            includeTags={includeTags}
            excludeTags={excludeTags}
            onCycle={cycleTag}
            onRemove={(t) => setTagMode(t, "neutral")}
            onClear={() => {
              setIncludeTags(new Set());
              setExcludeTags(new Set());
            }}
          />
          <div className="flex items-center gap-1.5">
            <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showVariants}
                onChange={(e) => setShowVariants(e.target.checked)}
              />
              Show variants
            </label>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  const mediaIds = displayMedia.map((m) => m.id);
                  if (mediaIds.length === 0) {
                    alert("No visible media to analyze.");
                    return;
                  }
                  const res = await fetch("/api/analyze-bulk", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ mediaIds }),
                  });
                  const data = await res.json();
                  if (!res.ok) {
                    alert(data.error ?? "Bulk analysis failed.");
                    return;
                  }
                  alert(
                    `Analysis finished. Success: ${data.successCount}, Failed: ${data.failureCount}`
                  );
                  refresh();
                } catch (error) {
                  console.error("[analyze-bulk] error:", error);
                  alert("Bulk analysis failed.");
                }
              }}
            >
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Analyze all visible
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
        </div>

        {/* Selection bar */}
        {selectedIds.size > 0 && (
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
                  if (allSelected)
                    visibleIds.forEach((id) => next.delete(id));
                  else visibleIds.forEach((id) => next.add(id));
                  return next;
                });
              }}
              disabled={displayMedia.length === 0}
            >
              <CheckSquare className="h-3.5 w-3.5 mr-1.5" />
              Select all visible
            </Button>
            <QuickStatusToolbar
              onApply={async (status) => {
                await fetch("/api/tags", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    mediaIds: Array.from(selectedIds),
                    clearPrefixes: ["status:"],
                    add: [`status:${status}`],
                  }),
                });
                refresh();
              }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  const mediaIds = Array.from(selectedIds);
                  if (mediaIds.length === 0) {
                    alert("No selected media to analyze.");
                    return;
                  }
                  const res = await fetch("/api/analyze-bulk", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ mediaIds }),
                  });
                  const data = await res.json();
                  if (!res.ok) {
                    alert(data.error ?? "Bulk analysis failed.");
                    return;
                  }
                  alert(
                    `Analysis finished. Success: ${data.successCount}, Failed: ${data.failureCount}`
                  );
                  refresh();
                } catch (error) {
                  console.error("[analyze-bulk] error:", error);
                  alert("Bulk analysis failed.");
                }
              }}
            >
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Analyze selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setInspectorOpen(true)}
            >
              Open inspector
            </Button>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              <X className="h-3.5 w-3.5 mr-1" />
              Cancel
            </Button>
          </div>
        )}

        {/* Suggestions banner */}
        {suggestionsOpen &&
          (suggestions.shoots.length > 0 ||
            suggestions.collections.length > 0) && (
            <div className="mb-4 p-3 rounded-lg border border-primary/20 bg-primary/5 space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium flex-1">
                  AI suggestions
                </span>
                <button
                  onClick={() => setSuggestionsOpen(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Dismiss
                </button>
              </div>
              {suggestions.shoots.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Detected shoots
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {suggestions.shoots.map((s) => (
                      <button
                        key={s.slug}
                        onClick={() => applyShootSuggestion(s)}
                        disabled={suggestionBusy === `shoot:${s.slug}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-full border border-primary/30 bg-white dark:bg-neutral-900 hover:bg-primary/10 transition-colors disabled:opacity-50"
                      >
                        {suggestionBusy === `shoot:${s.slug}` && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        <Camera className="h-3 w-3" />
                        {s.name.split(" — ")[0]}
                        <span className="text-xs text-muted-foreground">
                          ({s.count})
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {suggestions.collections.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Agency collections
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {suggestions.collections.map((c) => (
                      <button
                        key={c.name}
                        onClick={() => applyCollectionSuggestion(c)}
                        disabled={suggestionBusy === `col:${c.name}`}
                        title={c.description}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-full border border-primary/30 bg-white dark:bg-neutral-900 hover:bg-primary/10 transition-colors disabled:opacity-50"
                      >
                        {suggestionBusy === `col:${c.name}` && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        {c.name}
                        <span className="text-xs text-muted-foreground">
                          ({c.count})
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        {/* Upload */}
        <UploadDropzone
          creatorSlug={creatorSlug}
          creatorId={creatorId}
          onReadyForTriage={(items) => {
            if (items.length >= 3) setPendingTriage(items);
            else refresh();
          }}
        />

        {/* Main view */}
        <div className="mt-4">
          {viewMode === "planner" && active.kind === "channel" ? (
            <GridPlanner
              channel={active.channel as ChannelValue}
              media={displayMedia}
              onMutated={refresh}
            />
          ) : viewMode === "shoots" &&
            active.kind !== "channel" &&
            active.kind !== "folder" ? (
            <ShootsView
              shoots={sectionShoots}
              selectionMode={selectedIds.size > 0}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onApplyStatus={quickApplyStatus}
              onToggleHero={quickToggleHero}
              onOpenInspector={openInspectorFor}
              onTagClick={handleTileTagClick}
              onShootClick={jumpToShoot}
              tagCounts={tagCounts}
              totalFiles={media.length}
              onSelectAllInShoot={selectAllInShoot}
              onPromoteShoot={async (shoot) => {
                await fetch("/api/tags", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    mediaIds: shoot.items.map((i) => i.id),
                    add: [`shoot:${shoot.slug}`],
                    clearPrefixes: ["shoot:"],
                  }),
                });
                refresh();
              }}
              onOpenBurstCull={(items) => setBurstItems(items)}
              gridRef={gridRef}
              hideVariants={!showVariants}
            />
          ) : (
            <MediaGrid
              ref={gridRef}
              media={displayMedia}
              selectionMode={selectedIds.size > 0}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onTagClick={handleTileTagClick}
              onApplyStatus={quickApplyStatus}
              onToggleHero={quickToggleHero}
              onOpenInspector={openInspectorFor}
              onShootClick={jumpToShoot}
              tagCounts={tagCounts}
              totalFiles={media.length}
              hideVariants={!showVariants}
            />
          )}
        </div>
      </div>

      {/* Inspector side panel */}
      <InspectorPanel
        open={inspectorOpen && selectedItems.length > 0}
        onClose={() => setInspectorOpen(false)}
        items={selectedItems}
        folders={folders}
        creatorId={creatorId}
        onMutated={refresh}
      />

      {/* Cleanup tags dialog */}
      <CleanupTagsDialog
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        creatorId={creatorId}
      />

      {/* Burst cull modal */}
      {burstItems && (
        <BurstCullDialog
          items={burstItems}
          onClose={() => setBurstItems(null)}
          onApplied={refresh}
        />
      )}

      {/* Post-upload triage wizard */}
      {pendingTriage && pendingTriage.length > 0 && (
        <TriageWizard
          items={pendingTriage}
          onClose={() => {
            setPendingTriage(null);
            refresh();
          }}
          onDone={refresh}
        />
      )}

      {/* Keyboard help */}
      {keyboardHelpOpen && (
        <KeyboardHelp onClose={() => setKeyboardHelpOpen(false)} />
      )}
    </div>
  );
}

function QuickStatusToolbar({
  onApply,
}: {
  onApply: (status: StatusValue) => Promise<void>;
}) {
  const opts: StatusValue[] = [
    "approved-creator",
    "approved-brand",
    "scheduled",
    "posted",
    "rejected",
  ];
  return (
    <div className="flex items-center gap-0.5 flex-wrap">
      {opts.map((s) => (
        <Button
          key={s}
          size="sm"
          variant="ghost"
          onClick={() => onApply(s)}
          className="text-xs"
        >
          {STATUS_LABELS[s]}
        </Button>
      ))}
    </div>
  );
}

function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const shortcuts: [string, string][] = [
    ["← → ↑ ↓ / h j k l", "Move focus between tiles"],
    ["Space", "Select / deselect focused tile"],
    ["Enter", "Open full-screen viewer"],
    ["E", "Open inspector"],
    ["X", "Toggle hero pick"],
    ["1..6", "Apply status (raw / creator OK / brand OK / scheduled / posted / rejected)"],
    ["Esc", "Cancel selection or close panel"],
    ["?", "Show / hide this help"],
  ];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[min(90vw,28rem)] rounded-lg border bg-background p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold flex items-center gap-2">
            <Keyboard className="h-4 w-4" />
            Keyboard shortcuts
          </p>
          <button onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <dl className="space-y-1.5 text-sm">
          {shortcuts.map(([keys, desc]) => (
            <div key={keys} className="flex items-start gap-3">
              <dt className="shrink-0 text-xs font-mono bg-muted rounded px-1.5 py-0.5 min-w-[7rem] text-center">
                {keys}
              </dt>
              <dd className="text-muted-foreground">{desc}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-[11px] text-muted-foreground flex items-center gap-1.5">
          <Info className="h-3 w-3" />
          Click the grid first so keyboard focus is inside it.
        </p>
      </div>
    </div>
  );
}
