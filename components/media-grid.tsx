"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2, Download, Play } from "lucide-react";
import { MediaViewer } from "@/components/media-viewer";

interface MediaItem {
  id: string;
  filename: string;
  r2_key: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MediaGrid({ media }: { media: MediaItem[] }) {
  const [viewItem, setViewItem] = useState<MediaItem | null>(null);
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
        <p className="text-sm mt-1">Upload photos or videos using the area above</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 mt-6">
        {media.map((item) => {
          const isVideo = item.content_type.startsWith("video/");
          return (
            <div
              key={item.id}
              className="group relative rounded-lg border bg-card overflow-hidden"
            >
              <button
                onClick={() => setViewItem(item)}
                className="block w-full aspect-square bg-neutral-100 dark:bg-neutral-800 relative"
              >
                {isVideo ? (
                  <div className="flex items-center justify-center h-full">
                    <Play className="h-10 w-10 text-neutral-400" />
                  </div>
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
              <div className="p-3">
                <p
                  className="text-sm font-medium truncate"
                  title={item.filename}
                >
                  {item.filename}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatSize(item.size_bytes)} &middot;{" "}
                  {formatDate(item.created_at)}
                </p>
                <div className="flex gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <a
                    href={`/api/media/${item.id}?download=1`}
                    download={item.filename}
                    className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-muted transition-colors"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(item)}
                    disabled={deleting === item.id}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {viewItem && (
        <MediaViewer item={viewItem} onClose={() => setViewItem(null)} />
      )}
    </>
  );
}
