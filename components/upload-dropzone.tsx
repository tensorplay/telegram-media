"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  state: "uploading" | "done" | "error";
  error?: string;
}

export function UploadDropzone({
  creatorSlug,
  creatorId,
}: {
  creatorSlug: string;
  creatorId: string;
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

      let anySuccess = false;

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

            anySuccess = true;
            updateStatus(baseIndex, idx, { state: "done" });

            // Trigger AI analysis now that the file is in R2
            if (mediaId) {
              fetch("/api/analyze", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mediaId }),
                keepalive: true,
              }).catch(() => {});
            }
          } catch (err) {
            updateStatus(baseIndex, idx, {
              state: "error",
              error: err instanceof Error ? err.message : "Failed",
            });
          }
        })
      );

      if (anySuccess) {
        setTimeout(() => window.location.reload(), 2000);
      }
    },
    [creatorSlug, creatorId, uploads.length]
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
        className={`relative rounded-lg border-2 border-dashed p-4 sm:p-8 text-center transition-colors ${
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
        <Upload className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground mb-3">
          Drag and drop photos or videos here, or
        </p>
        <Button
          variant="outline"
          size="default"
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
        <p className="text-xs text-muted-foreground mt-3">
          JPG, PNG, WebP, GIF, MP4, MOV, WebM &middot; Max 500 MB
        </p>
      </div>

      {uploads.length > 0 && (
        <div className="mt-4 space-y-2">
          {uploads.map((u, i) => (
            <div
              key={i}
              className="flex items-center gap-2 text-sm rounded-md border px-3 py-2"
            >
              {u.state === "uploading" && (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
              {u.state === "done" && (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              )}
              {u.state === "error" && (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
              <span className="truncate flex-1">{u.name}</span>
              {u.error && (
                <span className="text-xs text-destructive">{u.error}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
