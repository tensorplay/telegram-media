"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2, Download, Play, Loader2 } from "lucide-react";
import { MediaViewer } from "@/components/media-viewer";

export interface MediaItem {
  id: string;
  filename: string;
  r2_key: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  ai_summary?: string | null;
  ai_tags?: string[] | null;
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

export function MediaGrid({ media }: { media: MediaItem[] }) {
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

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
                onClick={() => setViewIndex(index)}
                className="block w-full aspect-square bg-neutral-100 dark:bg-neutral-800 relative overflow-hidden"
              >
                {isVideo ? (
                  <>
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <video
                      src={`/api/media/${item.id}`}
                      preload="metadata"
                      muted
                      playsInline
                      className="object-cover w-full h-full"
                    />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                      <Play className="h-10 w-10 text-white drop-shadow" />
                    </div>
                  </>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media/${item.id}`}
                    alt={item.filename}
                    className="object-cover w-full h-full"
                    loading="lazy"
                  />
                )}
                {isVideo && (
                  <Badge
                    variant="secondary"
                    className="absolute top-2 right-2 text-xs"
                  >
                    Video
                  </Badge>
                )}
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
                      <span
                        key={tag}
                        className="inline-block px-1.5 py-0.5 text-[10px] rounded-full bg-secondary text-secondary-foreground"
                      >
                        {tag}
                      </span>
                    ))}
                    {item.ai_tags.length > 3 && (
                      <span className="text-[10px] text-muted-foreground py-0.5">
                        +{item.ai_tags.length - 3}
                      </span>
                    )}
                  </div>
                ) : !item.ai_summary ? (
                  <div className="flex items-center gap-1 mt-1.5 text-[10px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Analyzing...
                  </div>
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
