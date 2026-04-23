"use client";

import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Trash2, Download, Play, Loader2, RefreshCw, Info } from "lucide-react";
import { MediaViewer } from "@/components/media-viewer";
import { LazyMedia } from "@/components/lazy-media";

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

function formatDate(iso: string) {
  const d = new Date(iso);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const h = d.getUTCHours();
  const m = d.getUTCMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${h12}:${m} ${ampm}`;
}

export function MediaGrid({
  media,
  selectionMode = false,
  selectedIds,
  onToggleSelect,
  onTagClick,
}: {
  media: MediaItem[];
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onTagClick?: (tag: string, exclude: boolean) => void;
}) {
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);

  const retryAnalysis = useCallback(async (id: string) => {
    setAnalyzing(id);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: id }),
      });
      const data = await res.json();
      if (res.ok) {
        window.location.reload();
      } else {
        alert(`Analysis failed: ${data.error}`);
      }
    } catch (err) {
      alert(`Analysis error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
    setAnalyzing(null);
  }, []);

  async function handleDelete(item: MediaItem) {
    if (!confirm(`Delete "${item.filename}"?`)) return;
    setDeleting(item.id);
    const res = await fetch(`/api/media/${item.id}`, { method: "DELETE" });
    if (res.ok) {
      window.location.reload();
    }
    setDeleting(null);
  }

  if (media.length === 0) {
    return (
      <div className="mt-8 text-center text-muted-foreground py-16 border-2 border-dashed rounded-lg">
        <p className="text-lg">No media yet</p>
        <p className="text-sm mt-1">
          Upload photos or videos using the area above
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 sm:gap-4 mt-6">
        {media.map((item, index) => {
          const isVideo = item.content_type.startsWith("video/");
          return (
            <div
              key={item.id}
              className="group relative rounded-lg border bg-card overflow-hidden touch-manipulation"
            >
              <button
                onClick={() => {
                  if (selectionMode && onToggleSelect) {
                    onToggleSelect(item.id);
                  } else {
                    setViewIndex(index);
                  }
                }}
                className="block w-full aspect-square bg-neutral-100 dark:bg-neutral-800 relative overflow-hidden"
              >
                {selectionMode && (
                  <div
                    className={`absolute top-2 left-2 z-10 h-5 w-5 rounded border-2 flex items-center justify-center transition-colors ${
                      selectedIds?.has(item.id)
                        ? "bg-primary border-primary text-primary-foreground"
                        : "bg-white/80 border-neutral-400"
                    }`}
                  >
                    {selectedIds?.has(item.id) && (
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                )}
                <LazyMedia
                  mediaId={item.id}
                  isVideo={isVideo}
                  alt={item.filename}
                  className="object-cover w-full h-full"
                />
                {isVideo && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20 pointer-events-none">
                    <Play className="h-10 w-10 text-white drop-shadow" />
                  </div>
                )}
                <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
                  {isVideo && (
                    <Badge
                      variant="secondary"
                      className="text-xs"
                    >
                      Video
                    </Badge>
                  )}
                  {item.has_taxonomy && (
                    <Badge
                      variant="default"
                      className="text-[10px]"
                    >
                      Taxonomy
                    </Badge>
                  )}
                </div>
              </button>
              <div className="p-2 sm:p-3">
                <p
                  className="text-xs sm:text-sm font-medium truncate"
                  title={item.filename}
                >
                  {item.filename}
                </p>
                <p className="text-[10px] sm:text-xs text-muted-foreground mt-0.5" suppressHydrationWarning>
                  {formatSize(item.size_bytes)} {"\u00B7"}{" "}
                  {formatDate(item.created_at)}
                </p>
                {item.ai_tags && item.ai_tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {item.ai_tags.slice(0, 3).map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTagClick?.(tag, e.shiftKey);
                        }}
                        title={
                          onTagClick
                            ? `Click to filter by "${tag}" (shift-click to exclude)`
                            : tag
                        }
                        className="inline-block px-1.5 py-0.5 text-[10px] rounded-full bg-secondary text-secondary-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
                      >
                        {tag}
                      </button>
                    ))}
                    {item.ai_tags.length > 3 && (
                      <Dialog>
                        <DialogTrigger
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground py-0.5 hover:text-foreground transition-colors cursor-pointer"
                        >
                          +{item.ai_tags.length - 3}
                          <Info className="h-2.5 w-2.5" />
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-md">
                          <DialogHeader>
                            <DialogTitle className="text-base">
                              AI Analysis
                            </DialogTitle>
                          </DialogHeader>
                          <div className="space-y-4">
                            {item.ai_summary && (
                              <div>
                                <p className="text-xs font-medium text-muted-foreground mb-1">
                                  Summary
                                </p>
                                <p className="text-sm leading-relaxed">
                                  {item.ai_summary}
                                </p>
                              </div>
                            )}
                            <div>
                              <p className="text-xs font-medium text-muted-foreground mb-2">
                                Tags
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                                {item.ai_tags!.map((tag) => (
                                  <button
                                    key={tag}
                                    type="button"
                                    onClick={(e) =>
                                      onTagClick?.(tag, e.shiftKey)
                                    }
                                    title={
                                      onTagClick
                                        ? `Click to filter by "${tag}" (shift-click to exclude)`
                                        : tag
                                    }
                                    className="inline-block px-2 py-1 text-xs rounded-full bg-secondary text-secondary-foreground hover:bg-secondary/70 transition-colors"
                                  >
                                    {tag}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </DialogContent>
                      </Dialog>
                    )}
                  </div>
                ) : !item.ai_summary ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      retryAnalysis(item.id);
                    }}
                    disabled={analyzing === item.id}
                    className="flex items-center gap-1 mt-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {analyzing === item.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    {analyzing === item.id ? "Analyzing..." : "Analyze"}
                  </button>
                ) : null}
                <div className="flex gap-1 mt-1.5 sm:mt-2 max-sm:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                  <a
                    href={`/api/media/${item.id}?download=1`}
                    download={item.filename}
                    className="inline-flex items-center justify-center h-8 w-8 sm:h-7 sm:w-7 rounded-md hover:bg-muted active:bg-muted transition-colors touch-manipulation"
                  >
                    <Download className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                  </a>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 sm:h-7 sm:w-7 text-destructive hover:text-destructive active:text-destructive touch-manipulation"
                    onClick={() => handleDelete(item)}
                    disabled={deleting === item.id}
                  >
                    <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {viewIndex !== null && (
        <MediaViewer
          media={media}
          startIndex={viewIndex}
          onClose={() => setViewIndex(null)}
        />
      )}
    </>
  );
}
