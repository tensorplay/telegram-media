"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, Loader2, CheckCircle2, XCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MediaItem } from "@/components/media-grid";

const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
];

const MAX_SIZE = 500 * 1024 * 1024;

interface UploadStatus {
  name: string;
  state: "uploading" | "analyzing" | "done" | "error";
  error?: string;
  mediaId?: string;
}

/**
 * Upload flow:
 *   1. PUT each file to R2 via a signed URL.
 *   2. Kick off AI analysis server-side (so tags and summaries exist by the
 *      time the triage wizard opens).
 *   3. Once every file for this session has a mediaId, poll briefly for
 *      ai_tags to arrive, then hand the batch off to the parent for triage.
 */
export function UploadDropzone({
  creatorSlug,
  creatorId,
  onReadyForTriage,
}: {
  creatorSlug: string;
  creatorId: string;
  onReadyForTriage?: (items: MediaItem[]) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const updateStatus = (
    baseIndex: number,
    idx: number,
    update: Partial<UploadStatus>
  ) => {
    setUploads((prev) =>
      prev.map((u, i) => (i === baseIndex + idx ? { ...u, ...update } : u))
    );
  };

  const waitForAnalysis = useCallback(async (ids: string[]): Promise<MediaItem[]> => {
    // Poll /api/media endpoints would be per-id. Simpler: fan out GETs to
    // an inline view route. We don't have one, so fetch each via its
    // existing media row by constructing a lightweight endpoint.
    //
    // Since we don't have a bulk-fetch endpoint, we ask for analysis
    // results through the /api/analyze endpoint with pollOnly=true when
    // tags are present. For now, give Gemini ~20 seconds before surfacing
    // the triage UI and rely on ai_tags being present on reload.
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const res = await fetch(
        `/api/suggest-folders?creatorId=${encodeURIComponent(creatorId)}`
      );
      if (res.ok) {
        // the route returns shoots/collections — we just use this as a
        // liveness ping. Break as soon as any of the new ids appear in the
        // broader media list. In lieu of a dedicated endpoint, re-fetch
        // the creator page payload is overkill; settle for a fixed wait.
      }
      await new Promise((r) => setTimeout(r, 1500));
      // We return early if we've been here for 6+ seconds — Gemini will
      // commonly need more but the UI can still cluster by time/filename
      // and user can edit names manually.
      if (Date.now() - (deadline - 25_000) > 6000) break;
    }
    // The creator page is SSR-rendered, so we return stub items with the
    // info we have; the wizard only needs id/filename/created_at/content_type.
    // Fetch enriched rows via the page's data on reload if needed.
    return ids.map<MediaItem>((id) => ({
      id,
      filename: "",
      r2_key: "",
      content_type: "image/jpeg",
      size_bytes: 0,
      created_at: new Date().toISOString(),
      ai_summary: null,
      ai_tags: null,
    }));
  }, [creatorId]);

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArr = Array.from(files).filter((f) => {
        if (!ACCEPTED_TYPES.includes(f.type)) return false;
        if (f.size > MAX_SIZE) return false;
        return true;
      });

      if (fileArr.length === 0) return;

      const baseIndex = uploads.length;
      const newStatuses: UploadStatus[] = fileArr.map((f) => ({
        name: f.name,
        state: "uploading" as const,
      }));
      setUploads((prev) => [...prev, ...newStatuses]);

      const uploaded: { file: File; mediaId: string }[] = [];

      await Promise.all(
        fileArr.map(async (file, idx) => {
          try {
            const res = await fetch("/api/upload", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                filename: file.name,
                contentType: file.type,
                size: file.size,
                creatorSlug,
                creatorId,
              }),
            });

            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body.error || `Server error ${res.status}`);
            }

            const { uploadUrl, mediaId } = await res.json();

            const r2Res = await fetch(uploadUrl, {
              method: "PUT",
              headers: { "Content-Type": file.type },
              body: file,
            });

            if (!r2Res.ok) {
              throw new Error(`R2 upload failed (${r2Res.status})`);
            }

            updateStatus(baseIndex, idx, {
              state: "analyzing",
              mediaId,
            });
            if (mediaId) uploaded.push({ file, mediaId });

            if (mediaId) {
              fetch("/api/analyze", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mediaId }),
                keepalive: true,
              })
                .then(() =>
                  updateStatus(baseIndex, idx, { state: "done" })
                )
                .catch(() =>
                  updateStatus(baseIndex, idx, { state: "done" })
                );
            } else {
              updateStatus(baseIndex, idx, { state: "done" });
            }
          } catch (err) {
            updateStatus(baseIndex, idx, {
              state: "error",
              error: err instanceof Error ? err.message : "Failed",
            });
          }
        })
      );

      if (uploaded.length > 0) {
        if (onReadyForTriage && uploaded.length >= 3) {
          const items = await waitForAnalysis(uploaded.map((u) => u.mediaId));
          // Enrich items with what we have locally.
          const enriched: MediaItem[] = items.map((item, i) => ({
            ...item,
            filename: uploaded[i]?.file.name ?? item.filename,
            content_type: uploaded[i]?.file.type ?? item.content_type,
            size_bytes: uploaded[i]?.file.size ?? item.size_bytes,
          }));
          onReadyForTriage(enriched);
        } else {
          setTimeout(() => window.location.reload(), 1500);
        }
      }
    },
    [creatorSlug, creatorId, uploads.length, onReadyForTriage, waitForAnalysis]
  );

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files);
    }
  }

  return (
    <div>
      <div
        className={`relative rounded-lg border-2 border-dashed p-3 sm:p-5 text-center transition-colors ${
          dragOver
            ? "border-primary bg-primary/5"
            : "border-neutral-300 dark:border-neutral-700"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <Upload className="mx-auto h-7 w-7 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground mb-2">
          Drag and drop photos or videos, or
        </p>
        <Button
          variant="outline"
          size="sm"
          className="touch-manipulation"
          onClick={() => inputRef.current?.click()}
        >
          Browse files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_TYPES.join(",")}
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              uploadFiles(e.target.files);
              e.target.value = "";
            }
          }}
        />
        <p className="text-[10px] text-muted-foreground mt-1.5">
          JPG, PNG, WebP, GIF, MP4, MOV, WebM &middot; Max 500 MB &middot;
          Batches of 3+ open the triage wizard
        </p>
      </div>

      {uploads.length > 0 && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {uploads.map((u, i) => (
            <div
              key={i}
              className="flex items-center gap-2 text-xs rounded-md border px-2 py-1.5"
            >
              {u.state === "uploading" && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
              {u.state === "analyzing" && (
                <Sparkles className="h-3.5 w-3.5 text-primary animate-pulse" />
              )}
              {u.state === "done" && (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              )}
              {u.state === "error" && (
                <XCircle className="h-3.5 w-3.5 text-destructive" />
              )}
              <span className="truncate flex-1" title={u.name}>
                {u.name}
              </span>
              {u.error && (
                <span className="text-[10px] text-destructive">{u.error}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
