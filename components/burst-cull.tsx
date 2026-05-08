"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Star, Trash2, X, Check } from "lucide-react";
import { LazyMedia } from "@/components/lazy-media";
import type { MediaItem } from "@/components/media-grid";
import { parseTags } from "@/lib/facets";

/**
 * Burst-cull: present a near-duplicate group, let the operator mark one as
 * the hero with a single keystroke. The rest get the `variant` tag (so they
 * stay visible in the library but hidden by default) or can be deleted
 * outright.
 */
export function BurstCullDialog({
  items,
  onClose,
  onApplied,
}: {
  items: MediaItem[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const [current, setCurrent] = useState(() => {
    const heroIdx = items.findIndex((i) => parseTags(i.ai_tags).system.hero);
    return heroIdx === -1 ? 0 : heroIdx;
  });
  const [busy, setBusy] = useState(false);

  const applyPick = useCallback(
    async (heroIdx: number, deleteVariants: boolean) => {
      setBusy(true);
      try {
        const heroId = items[heroIdx].id;
        const variantIds = items.filter((_, i) => i !== heroIdx).map((m) => m.id);

        await fetch("/api/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mediaIds: [heroId],
            add: ["hero"],
            remove: ["variant"],
          }),
        });

        if (deleteVariants) {
          await Promise.all(
            variantIds.map((id) =>
              fetch(`/api/media/${id}`, { method: "DELETE" })
            )
          );
        } else if (variantIds.length > 0) {
          await fetch("/api/tags", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mediaIds: variantIds,
              add: ["variant"],
              remove: ["hero"],
            }),
          });
        }
        onApplied();
        onClose();
      } finally {
        setBusy(false);
      }
    },
    [items, onApplied, onClose]
  );

  const primary = items[current];

  useEffect(() => {
    function handle(e: KeyboardEvent) {
      if (busy) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "l" || e.key === "j") {
        e.preventDefault();
        setCurrent((i) => Math.min(items.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "h" || e.key === "k") {
        e.preventDefault();
        setCurrent((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "p" || e.key === "P" || e.key === "x" || e.key === "X" || e.key === "Enter") {
        e.preventDefault();
        applyPick(current, false);
        return;
      }
      if (e.key === "d" || e.key === "D" || e.key === "Delete") {
        e.preventDefault();
        if (confirm(`Keep only the selected shot and delete the other ${items.length - 1}?`)) {
          applyPick(current, true);
        }
      }
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [current, items.length, applyPick, onClose, busy]);

  const pickIds = useMemo(() => items.map((i) => i.id), [items]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-sm">
      <header className="flex items-center justify-between px-4 py-3 text-white/90 shrink-0">
        <div>
          <p className="text-sm font-semibold">Pick the hero</p>
          <p className="text-xs text-white/50">
            {items.length} near-duplicate{items.length === 1 ? "" : "s"} · arrows to
            navigate · P to pick · D to pick-and-delete the rest · Esc to cancel
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="text-white hover:bg-white/10"
        >
          <X className="h-5 w-5" />
        </Button>
      </header>

      <div className="flex-1 min-h-0 flex items-center justify-center px-4">
        {primary && (
          <LazyMedia
            mediaId={primary.id}
            isVideo={primary.content_type.startsWith("video/")}
            alt={primary.filename}
            eager
            className="max-w-full max-h-[calc(100vh-16rem)] rounded-lg object-contain"
          />
        )}
      </div>

      <div className="shrink-0 bg-black/70 backdrop-blur-sm border-t border-white/10 px-4 py-3 overflow-x-auto">
        <div className="flex gap-2 justify-center">
          {items.map((item, idx) => {
            const isCurrent = idx === current;
            const isHero = parseTags(item.ai_tags).system.hero;
            return (
              <button
                key={item.id}
                onClick={() => setCurrent(idx)}
                className={`relative h-20 w-20 shrink-0 rounded-md overflow-hidden border-2 transition-colors ${
                  isCurrent
                    ? "border-primary"
                    : "border-white/10 hover:border-white/40"
                }`}
              >
                <LazyMedia
                  mediaId={item.id}
                  isVideo={item.content_type.startsWith("video/")}
                  alt={item.filename}
                  className="object-cover w-full h-full"
                />
                {isHero && (
                  <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-amber-400 text-white flex items-center justify-center">
                    <Star className="h-2.5 w-2.5 fill-current" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <footer className="shrink-0 flex items-center justify-center gap-2 px-4 py-3 bg-black/70 border-t border-white/10">
        <Button
          variant="outline"
          onClick={() => applyPick(current, false)}
          disabled={busy}
          className="bg-white/10 border-white/20 text-white hover:bg-white/20"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Check className="h-4 w-4 mr-2" />
          )}
          Pick hero (P)
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            if (
              confirm(
                `Keep only the selected shot and delete the other ${pickIds.length - 1}?`
              )
            )
              applyPick(current, true);
          }}
          disabled={busy}
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Pick + delete rest (D)
        </Button>
      </footer>
    </div>
  );
}
