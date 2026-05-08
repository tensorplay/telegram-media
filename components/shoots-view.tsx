"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Camera,
  ChevronRight,
  ChevronDown,
  Star,
  CheckSquare,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { MediaItem } from "@/components/media-grid";
import { MediaGrid, type MediaGridHandle } from "@/components/media-grid";
import type { Shoot } from "@/lib/shoots";
import { detectBursts } from "@/lib/shoots";
import { parseTags } from "@/lib/facets";

export function ShootsView({
  shoots,
  selectionMode,
  selectedIds,
  onToggleSelect,
  onApplyStatus,
  onToggleHero,
  onOpenInspector,
  onTagClick,
  onShootClick,
  tagCounts,
  totalFiles,
  onSelectAllInShoot,
  onPromoteShoot,
  onOpenBurstCull,
  gridRef,
  hideVariants,
}: {
  shoots: Shoot<MediaItem & { folder_id?: string | null }>[];
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onApplyStatus: (id: string, status: import("@/lib/facets").StatusValue) => void;
  onToggleHero: (id: string) => void;
  onOpenInspector: (id: string) => void;
  onTagClick: (tag: string, exclude: boolean) => void;
  onShootClick: (slug: string) => void;
  tagCounts: Map<string, number>;
  totalFiles: number;
  onSelectAllInShoot: (ids: string[]) => void;
  onPromoteShoot: (shoot: Shoot<MediaItem & { folder_id?: string | null }>) => void;
  onOpenBurstCull: (items: MediaItem[]) => void;
  gridRef?: React.Ref<MediaGridHandle>;
  hideVariants: boolean;
}) {
  if (shoots.length === 0) {
    return (
      <div className="mt-8 text-center text-muted-foreground py-16 border-2 border-dashed rounded-lg">
        <p className="text-lg">No shoots here yet</p>
        <p className="text-sm mt-1">
          Upload a session and we&apos;ll cluster it automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {shoots.map((shoot, idx) => (
        <ShootRow
          key={shoot.id}
          shoot={shoot}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onApplyStatus={onApplyStatus}
          onToggleHero={onToggleHero}
          onOpenInspector={onOpenInspector}
          onTagClick={onTagClick}
          onShootClick={onShootClick}
          tagCounts={tagCounts}
          totalFiles={totalFiles}
          onSelectAllInShoot={onSelectAllInShoot}
          onPromoteShoot={onPromoteShoot}
          onOpenBurstCull={onOpenBurstCull}
          defaultOpen={idx < 3}
          gridRef={idx === 0 ? gridRef : undefined}
          hideVariants={hideVariants}
        />
      ))}
    </div>
  );
}

function ShootRow({
  shoot,
  selectionMode,
  selectedIds,
  onToggleSelect,
  onApplyStatus,
  onToggleHero,
  onOpenInspector,
  onTagClick,
  onShootClick,
  tagCounts,
  totalFiles,
  onSelectAllInShoot,
  onPromoteShoot,
  onOpenBurstCull,
  defaultOpen,
  gridRef,
  hideVariants,
}: {
  shoot: Shoot<MediaItem & { folder_id?: string | null }>;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onApplyStatus: (id: string, status: import("@/lib/facets").StatusValue) => void;
  onToggleHero: (id: string) => void;
  onOpenInspector: (id: string) => void;
  onTagClick: (tag: string, exclude: boolean) => void;
  onShootClick: (slug: string) => void;
  tagCounts: Map<string, number>;
  totalFiles: number;
  onSelectAllInShoot: (ids: string[]) => void;
  onPromoteShoot: (shoot: Shoot<MediaItem & { folder_id?: string | null }>) => void;
  onOpenBurstCull: (items: MediaItem[]) => void;
  defaultOpen: boolean;
  gridRef?: React.Ref<MediaGridHandle>;
  hideVariants: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const heroItem = useMemo(() => {
    for (const it of shoot.items) {
      if (parseTags(it.ai_tags).system.hero) return it;
    }
    return shoot.items[0];
  }, [shoot.items]);

  const bursts = useMemo(() => detectBursts(shoot), [shoot]);

  const heroCount = useMemo(
    () => shoot.items.filter((i) => parseTags(i.ai_tags).system.hero).length,
    [shoot.items]
  );

  const dateRange = useMemo(() => {
    const s = new Date(shoot.startsAt);
    const e = new Date(shoot.endsAt);
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    return fmt(s) === fmt(e) ? fmt(s) : `${fmt(s)} – ${fmt(e)}`;
  }, [shoot.startsAt, shoot.endsAt]);

  return (
    <section className="rounded-lg border bg-card overflow-hidden">
      <header className="flex items-center gap-3 px-3 py-2.5">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
          <Camera className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-medium text-sm truncate">{shoot.name}</span>
          <span className="text-xs text-muted-foreground shrink-0">
            {shoot.items.length} files · {dateRange}
          </span>
          {heroCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 shrink-0">
              <Star className="h-3 w-3 fill-current" />
              {heroCount}
            </span>
          )}
          {shoot.promoted && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 shrink-0">
              saved
            </span>
          )}
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {bursts.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenBurstCull(bursts[0])}
              title={`${bursts.length} near-duplicate burst${bursts.length === 1 ? "" : "s"} detected`}
            >
              <Wand2 className="h-3.5 w-3.5 mr-1.5" />
              Cull ({bursts.length})
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSelectAllInShoot(shoot.items.map((i) => i.id))}
          >
            <CheckSquare className="h-3.5 w-3.5 mr-1.5" />
            Select
          </Button>
          {!shoot.promoted && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPromoteShoot(shoot)}
              title="Save this shoot so it sticks across future sessions"
            >
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Save
            </Button>
          )}
          {shoot.promoted && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onShootClick(shoot.slug)}
            >
              Open
            </Button>
          )}
        </div>
      </header>
      {!open && heroItem && (
        <div className="px-3 pb-3 flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Top tags:</span>
          {shoot.topTags.slice(0, 5).map((t) => (
            <button
              key={t}
              onClick={() => onTagClick(t, false)}
              className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary hover:bg-secondary/70"
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="px-3 pb-3">
          <MediaGrid
            ref={gridRef}
            media={shoot.items}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
            onTagClick={onTagClick}
            onApplyStatus={onApplyStatus}
            onToggleHero={onToggleHero}
            onOpenInspector={onOpenInspector}
            onShootClick={onShootClick}
            tagCounts={tagCounts}
            totalFiles={totalFiles}
            density="compact"
            hideVariants={hideVariants}
          />
        </div>
      )}
    </section>
  );
}
