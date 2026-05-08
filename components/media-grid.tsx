"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import {
  Play,
  Loader2,
  RefreshCw,
  Star,
  Layers,
  Camera,
  CircleDashed,
  CheckCircle2,
  CalendarClock,
  Send,
  XCircle,
} from "lucide-react";
import { MediaViewer } from "@/components/media-viewer";
import { LazyMedia } from "@/components/lazy-media";
import {
  parseTags,
  primaryStatus,
  distinctiveTags,
  STATUS_LABELS,
  STATUS_TONE,
  type StatusValue,
} from "@/lib/facets";

export interface MediaItem {
  id: string;
  filename: string;
  r2_key: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  ai_summary?: string | null;
  ai_tags?: string[] | null;
  has_taxonomy?: boolean;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type GridAspect = "square" | "ig-4x5" | "vertical-9x16";
export type GridDensity = "comfortable" | "compact";

export interface MediaGridHandle {
  /** Focus the grid so keyboard shortcuts work. */
  focus(): void;
}

export const MediaGrid = forwardRef<
  MediaGridHandle,
  {
    media: MediaItem[];
    selectionMode?: boolean;
    selectedIds?: Set<string>;
    onToggleSelect?: (id: string) => void;
    onTagClick?: (tag: string, exclude: boolean) => void;
    /** Called when the user applies a status via keyboard shortcut 1..5. */
    onApplyStatus?: (id: string, status: StatusValue) => void;
    /** Called when the user toggles hero via `x`. */
    onToggleHero?: (id: string) => void;
    /** Called when `e` opens the inspector for a single file. */
    onOpenInspector?: (id: string) => void;
    /** Called when a shoot chip on a tile is clicked. */
    onShootClick?: (slug: string) => void;
    aspect?: GridAspect;
    density?: GridDensity;
    /** Per-creator tag frequency counts, used to pick distinctive tags per tile. */
    tagCounts?: Map<string, number>;
    totalFiles?: number;
    /** When true, hide any tile carrying the `variant` system tag. */
    hideVariants?: boolean;
    /** Columns override (per breakpoint). Default auto-responsive. */
    columns?: number;
  }
>(function MediaGrid(
  {
    media,
    selectionMode = false,
    selectedIds,
    onToggleSelect,
    onTagClick,
    onApplyStatus,
    onToggleHero,
    onOpenInspector,
    onShootClick,
    aspect = "square",
    density = "comfortable",
    tagCounts,
    totalFiles,
    hideVariants = true,
    columns,
  },
  ref
) {
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        containerRef.current?.focus();
      },
    }),
    []
  );

  const retryAnalysis = useCallback(
    async (id: string) => {
      setAnalyzing(id);
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaId: id }),
        });
        const data = await res.json();
        if (res.ok) {
          router.refresh();
        } else {
          alert(`Analysis failed: ${data.error}`);
        }
      } catch (err) {
        alert(
          `Analysis error: ${err instanceof Error ? err.message : "Unknown"}`
        );
      }
      setAnalyzing(null);
    },
    [router]
  );

  const visible = useMemo(() => {
    if (!hideVariants) return media;
    return media.filter((m) => {
      const { system } = parseTags(m.ai_tags);
      return !system.variant || system.hero;
    });
  }, [media, hideVariants]);

  const aspectClass =
    aspect === "ig-4x5"
      ? "aspect-[4/5]"
      : aspect === "vertical-9x16"
        ? "aspect-[9/16]"
        : "aspect-square";

  // Column counts respond to the grid's *container* width, not the viewport.
  // This matters when the inspector panel slides in from the right and steals
  // ~22rem from the main column — without container queries the grid would
  // keep drawing 8 cols in a much narrower box and tiles would shrink.
  const gridColsClass = useMemo(() => {
    if (columns) {
      if (columns === 3) return "grid-cols-3";
      if (columns === 4) return "grid-cols-4";
      if (columns === 5) return "grid-cols-5";
      if (columns === 6) return "grid-cols-6";
    }
    if (density === "compact") {
      return "grid-cols-3 @md:grid-cols-4 @2xl:grid-cols-6 @4xl:grid-cols-8";
    }
    return "grid-cols-2 @md:grid-cols-3 @2xl:grid-cols-4 @4xl:grid-cols-5";
  }, [density, columns]);

  const gapClass = density === "compact" ? "gap-1.5 @sm:gap-2" : "gap-3 @sm:gap-4";

  // Keyboard navigation: j/k/arrow keys move focus, space selects,
  // 1..6 apply a status, x toggles hero, e opens inspector, enter opens viewer.
  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (visible.length === 0) return;
      const target = e.target as HTMLElement;
      // Don't intercept keystrokes while the user types in an input.
      if (target.closest("input, textarea, [contenteditable]")) return;

      const idx = focusIndex ?? 0;
      const current = visible[idx];
      const move = (delta: number) => {
        e.preventDefault();
        const next = Math.max(0, Math.min(visible.length - 1, idx + delta));
        setFocusIndex(next);
      };
      switch (e.key) {
        case "ArrowRight":
        case "l":
          move(1);
          return;
        case "ArrowLeft":
        case "h":
          move(-1);
          return;
        case "ArrowDown":
        case "j":
          move(5);
          return;
        case "ArrowUp":
        case "k":
          move(-5);
          return;
        case " ":
          if (current && onToggleSelect) {
            e.preventDefault();
            onToggleSelect(current.id);
          }
          return;
        case "Enter":
          if (current) {
            e.preventDefault();
            setViewIndex(idx);
          }
          return;
        case "x":
        case "X":
          if (current && onToggleHero) {
            e.preventDefault();
            onToggleHero(current.id);
          }
          return;
        case "e":
        case "E":
          if (current && onOpenInspector) {
            e.preventDefault();
            onOpenInspector(current.id);
          }
          return;
      }
      if (/^[1-6]$/.test(e.key) && current && onApplyStatus) {
        const map: StatusValue[] = [
          "raw",
          "approved-creator",
          "approved-brand",
          "scheduled",
          "posted",
          "rejected",
        ];
        const status = map[parseInt(e.key, 10) - 1];
        if (status) {
          e.preventDefault();
          onApplyStatus(current.id, status);
        }
      }
    },
    [
      visible,
      focusIndex,
      onApplyStatus,
      onOpenInspector,
      onToggleHero,
      onToggleSelect,
    ]
  );

  // Keep focus within bounds if the list shrinks.
  useEffect(() => {
    if (focusIndex !== null && focusIndex >= visible.length) {
      setFocusIndex(visible.length === 0 ? null : visible.length - 1);
    }
  }, [visible.length, focusIndex]);

  if (visible.length === 0) {
    return (
      <div className="mt-8 text-center text-muted-foreground py-16 border-2 border-dashed rounded-lg">
        <p className="text-lg">No media here</p>
        <p className="text-sm mt-1">
          Upload files or switch to a different section on the left.
        </p>
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKey}
        className="@container outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-lg"
      >
        <div className={`grid ${gridColsClass} ${gapClass}`}>
          {visible.map((item, index) => {
            const isVideo = item.content_type.startsWith("video/");
            const { content, system } = parseTags(item.ai_tags);
            const status = primaryStatus(system.statuses);
            const distinct =
              tagCounts && totalFiles
                ? distinctiveTags(
                    content,
                    tagCounts,
                    totalFiles,
                    density === "compact" ? 0 : 3
                  )
                : content.slice(0, density === "compact" ? 0 : 3);
            const selected = selectedIds?.has(item.id) ?? false;
            const focused = focusIndex === index;
            return (
              <div
                key={item.id}
                className={`group relative rounded-lg border bg-card overflow-hidden touch-manipulation transition-shadow ${
                  focused ? "ring-2 ring-primary shadow-md" : ""
                } ${selected ? "ring-2 ring-primary/70" : ""}`}
              >
                <button
                  onClick={() => {
                    setFocusIndex(index);
                    if (selectionMode && onToggleSelect) {
                      onToggleSelect(item.id);
                    } else {
                      setViewIndex(index);
                    }
                  }}
                  onDoubleClick={() => onOpenInspector?.(item.id)}
                  className={`block w-full ${aspectClass} bg-neutral-100 dark:bg-neutral-800 relative overflow-hidden`}
                >
                  <LazyMedia
                    mediaId={item.id}
                    isVideo={isVideo}
                    alt={item.filename}
                    className="object-cover w-full h-full"
                  />

                  {/* top-left: selection checkbox / hero star / variant badge */}
                  <div className="absolute top-1.5 left-1.5 flex items-center gap-1 z-10">
                    {onToggleSelect && (
                      <button
                        type="button"
                        aria-label={selected ? "Deselect" : "Select"}
                        aria-pressed={selected}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          setFocusIndex(index);
                          onToggleSelect(item.id);
                        }}
                        className={`h-5 w-5 rounded border-2 flex items-center justify-center transition-all ${
                          selected
                            ? "bg-primary border-primary text-primary-foreground opacity-100"
                            : "bg-white/80 border-neutral-400 hover:bg-white hover:border-primary"
                        } ${
                          selectionMode || selected
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        }`}
                      >
                        {selected && (
                          <svg
                            className="h-3 w-3"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={3}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        )}
                      </button>
                    )}
                    {system.hero && (
                      <span
                        className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-amber-400 text-white shadow"
                        title="Hero pick"
                      >
                        <Star className="h-3 w-3 fill-current" />
                      </span>
                    )}
                    {system.variant && !system.hero && (
                      <span
                        className="inline-flex items-center justify-center h-5 px-1.5 rounded-full bg-neutral-700 text-[9px] font-medium text-white shadow"
                        title="Variant of a hero pick"
                      >
                        Variant
                      </span>
                    )}
                  </div>

                  {/* top-right: status pill + video badge + taxonomy badge */}
                  <div className="absolute top-1.5 right-1.5 flex items-center gap-1 z-10">
                    {isVideo && (
                      <Badge
                        variant="secondary"
                        className="text-[9px] h-5 px-1.5"
                      >
                        Video
                      </Badge>
                    )}
                    {item.has_taxonomy && (
                      <Badge
                        variant="default"
                        className="text-[9px] h-5 px-1.5"
                        title="Taxonomy analysis available"
                      >
                        Taxonomy
                      </Badge>
                    )}
                    {status && <StatusPill status={status} />}
                  </div>

                  {/* bottom-left: shoot chip */}
                  {system.shoot && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onShootClick?.(system.shoot!);
                      }}
                      title={`Jump to shoot "${system.shoot}"`}
                      className="absolute bottom-1.5 left-1.5 z-10 inline-flex items-center gap-1 px-1.5 h-5 rounded-full bg-black/55 text-white text-[10px] backdrop-blur-sm hover:bg-black/70 max-w-[70%]"
                    >
                      <Camera className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate">{system.shoot}</span>
                    </button>
                  )}

                  {isVideo && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20 pointer-events-none">
                      <Play className="h-10 w-10 text-white drop-shadow" />
                    </div>
                  )}
                </button>

                {density === "comfortable" && (
                  <div className="p-2 sm:p-2.5">
                    {distinct.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {distinct.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onTagClick?.(tag, e.shiftKey);
                            }}
                            title={
                              onTagClick
                                ? `Filter by "${tag}" (shift-click to exclude)`
                                : tag
                            }
                            className="inline-block px-1.5 py-0.5 text-[10px] rounded-full bg-secondary text-secondary-foreground hover:bg-secondary/70 transition-colors"
                          >
                            {tag}
                          </button>
                        ))}
                        {content.length > distinct.length && (
                          <span className="text-[10px] text-muted-foreground py-0.5">
                            +{content.length - distinct.length}
                          </span>
                        )}
                      </div>
                    ) : !item.ai_summary && (!item.ai_tags || item.ai_tags.length === 0) ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          retryAnalysis(item.id);
                        }}
                        disabled={analyzing === item.id}
                        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {analyzing === item.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        {analyzing === item.id ? "Analyzing..." : "Analyze"}
                      </button>
                    ) : (
                      <span className="text-[10px] text-muted-foreground italic">
                        No distinctive tags
                      </span>
                    )}
                    {system.channels.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {system.channels.map((c) => (
                          <span
                            key={c}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] rounded bg-primary/10 text-primary border border-primary/20"
                          >
                            <Layers className="h-2.5 w-2.5" />
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {viewIndex !== null && (
        <MediaViewer
          media={visible}
          startIndex={viewIndex}
          onClose={() => setViewIndex(null)}
        />
      )}
    </>
  );
});

function StatusPill({ status }: { status: StatusValue }) {
  const tone = STATUS_TONE[status];
  const toneClass =
    tone === "green"
      ? "bg-emerald-500/90 text-white"
      : tone === "blue"
        ? "bg-sky-500/90 text-white"
        : tone === "amber"
          ? "bg-amber-500/90 text-white"
          : tone === "red"
            ? "bg-rose-500/90 text-white"
            : "bg-neutral-600/85 text-white";
  const Icon =
    status === "posted"
      ? Send
      : status === "scheduled"
        ? CalendarClock
        : status === "rejected"
          ? XCircle
          : status === "raw"
            ? CircleDashed
            : CheckCircle2;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 h-5 rounded-full text-[9px] font-medium backdrop-blur-sm shadow ${toneClass}`}
      title={STATUS_LABELS[status]}
    >
      <Icon className="h-2.5 w-2.5" />
      {STATUS_LABELS[status]}
    </span>
  );
}
