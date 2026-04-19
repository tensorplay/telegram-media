"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Wand2, ArrowRight } from "lucide-react";

type Preview = {
  mapping: Record<string, string>;
  mergedCount: number;
  totalTags: number;
  wouldChange: number;
  totalFiles: number;
};

export function CleanupTagsDialog({
  open,
  onOpenChange,
  creatorId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creatorId: string;
}) {
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ updatedCount: number } | null>(null);

  async function runPreview() {
    setLoading(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/merge-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatorId, apply: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Preview failed");
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setLoading(false);
    }
  }

  async function applyCleanup() {
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/api/merge-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatorId, apply: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Apply failed");
      setDone({ updatedCount: data.updatedCount ?? 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setApplying(false);
    }
  }

  function close(next: boolean) {
    if (!next) {
      setPreview(null);
      setError(null);
      const didApply = done !== null;
      setDone(null);
      onOpenChange(false);
      if (didApply) window.location.reload();
      return;
    }
    onOpenChange(next);
  }

  const mappingEntries = preview
    ? Object.entries(preview.mapping).sort((a, b) =>
        a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])
      )
    : [];

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Clean up tags</DialogTitle>
        </DialogHeader>

        {!preview && !loading && !error && (
          <div className="text-sm text-muted-foreground space-y-3">
            <p>
              This scans every tag on every file for this creator and asks
              Gemini to merge near-duplicates (e.g. <code>indoors</code> →{" "}
              <code>indoor</code>, <code>red-haired</code> →{" "}
              <code>red hair</code>).
            </p>
            <p>You&apos;ll see a preview before anything is written.</p>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
            <Loader2 className="h-4 w-4 animate-spin" />
            Analyzing tags with Gemini…
          </div>
        )}

        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 py-2">
            {error}
          </div>
        )}

        {preview && !done && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Found{" "}
              <span className="font-medium text-foreground">
                {preview.mergedCount}
              </span>{" "}
              tag variants to merge across{" "}
              <span className="font-medium text-foreground">
                {preview.totalTags}
              </span>{" "}
              distinct tags. This will update{" "}
              <span className="font-medium text-foreground">
                {preview.wouldChange}
              </span>{" "}
              of {preview.totalFiles} files.
            </p>
            {mappingEntries.length > 0 ? (
              <div className="max-h-72 overflow-y-auto rounded-md border divide-y text-sm">
                {mappingEntries.map(([variant, canonical]) => (
                  <div
                    key={variant}
                    className="flex items-center gap-2 px-3 py-1.5"
                  >
                    <span className="text-muted-foreground line-through truncate">
                      {variant}
                    </span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="font-medium truncate">{canonical}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground italic">
                Nothing to merge — tags already look clean.
              </div>
            )}
          </div>
        )}

        {done && (
          <div className="text-sm py-2">
            Updated{" "}
            <span className="font-medium">{done.updatedCount}</span> files.
            Reloading…
          </div>
        )}

        <DialogFooter>
          {!preview && !done && (
            <Button onClick={runPreview} disabled={loading}>
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Wand2 className="h-4 w-4 mr-2" />
              )}
              Preview merges
            </Button>
          )}
          {preview && !done && mappingEntries.length > 0 && (
            <Button onClick={applyCleanup} disabled={applying}>
              {applying ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Apply {preview.mergedCount} merge
              {preview.mergedCount === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
