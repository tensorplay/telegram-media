"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  X,
  Camera,
  Layers,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Check,
  SkipForward,
} from "lucide-react";
import type { MediaItem } from "@/components/media-grid";
import { LazyMedia } from "@/components/lazy-media";
import { CHANNELS, type ChannelValue } from "@/lib/facets";
import { clusterShoots, type Shoot } from "@/lib/shoots";

/**
 * Walks the user through each auto-detected shoot from their recent upload
 * and lets them: confirm/edit the name (writes a `shoot:<slug>` tag on
 * every member), pick initial target channels, and decide between batch
 * apply now vs review each one.
 */
export function TriageWizard({
  items,
  onClose,
  onDone,
}: {
  items: MediaItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const initialShoots = useMemo(() => clusterShoots(items), [items]);
  const [shoots, setShoots] = useState<
    (Shoot<MediaItem> & { channels: ChannelValue[]; skip: boolean })[]
  >(() =>
    initialShoots.map((s) => ({
      ...s,
      channels: [],
      skip: false,
    }))
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);

  const current = shoots[currentIdx];

  function updateCurrent(
    patch: Partial<Shoot<MediaItem>> & {
      channels?: ChannelValue[];
      skip?: boolean;
    }
  ) {
    setShoots((prev) =>
      prev.map((s, i) => (i === currentIdx ? { ...s, ...patch } : s))
    );
  }

  async function applyAll() {
    setBusy(true);
    try {
      for (const shoot of shoots) {
        if (shoot.skip) continue;
        const ids = shoot.items.map((i) => i.id);
        const adds: string[] = [
          `shoot:${shoot.slug}`,
          ...shoot.channels.map((c) => `channel:${c}`),
        ];
        if (!shoot.items.every((i) => (i.ai_tags ?? []).includes("status:raw"))) {
          // Fresh uploads default to "raw" so they show up in Inbox.
          adds.push("status:raw");
        }
        await fetch("/api/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mediaIds: ids,
            add: adds,
            clearPrefixes: ["shoot:"],
          }),
        });
      }
      setApplied(shoots.filter((s) => !s.skip).length);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (shoots.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-lg border bg-background shadow-2xl overflow-hidden">
        <header className="flex items-center justify-between px-5 py-3 border-b shrink-0">
          <div>
            <p className="text-sm font-semibold">
              Triage new uploads · {items.length} files · {shoots.length}{" "}
              auto-detected shoot{shoots.length === 1 ? "" : "s"}
            </p>
            <p className="text-xs text-muted-foreground">
              Confirm names, pick channels. Names become tags you can search
              and filter by.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        {applied !== null ? (
          <div className="p-8 text-center space-y-3">
            <Check className="h-12 w-12 mx-auto text-emerald-500" />
            <p className="text-lg font-semibold">
              Filed {applied} shoot{applied === 1 ? "" : "s"}
            </p>
            <p className="text-sm text-muted-foreground">
              You can always rename or re-shoot from the library.
            </p>
            <Button onClick={onClose}>Close</Button>
          </div>
        ) : (
          <>
            {/* Step indicator */}
            <div className="px-5 py-2 border-b bg-muted/30 shrink-0 flex items-center gap-1 overflow-x-auto">
              {shoots.map((s, idx) => (
                <button
                  key={s.id}
                  onClick={() => setCurrentIdx(idx)}
                  className={`shrink-0 px-2 py-1 text-[11px] rounded-md border transition-colors ${
                    idx === currentIdx
                      ? "bg-primary text-primary-foreground border-primary"
                      : s.skip
                        ? "bg-card border-dashed text-muted-foreground line-through"
                        : "bg-card border-border hover:bg-muted"
                  }`}
                >
                  {idx + 1}. {s.name.split(" — ")[0]}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
              <div className="flex items-center gap-3">
                <Camera className="h-5 w-5 text-muted-foreground shrink-0" />
                <Input
                  value={current.name}
                  onChange={(e) => updateCurrent({ name: e.target.value })}
                  className="text-base font-medium"
                />
                <span className="text-xs text-muted-foreground shrink-0">
                  {current.items.length} files
                </span>
              </div>

              {current.topTags.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    Detected content
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {current.topTags.map((t) => (
                      <span
                        key={t}
                        className="inline-block px-2 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                  <Layers className="h-3 w-3" />
                  Target channels (optional)
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {CHANNELS.map((c) => {
                    const isActive = current.channels.includes(c.value);
                    return (
                      <button
                        key={c.value}
                        onClick={() => {
                          const next = isActive
                            ? current.channels.filter((v) => v !== c.value)
                            : [...current.channels, c.value];
                          updateCurrent({ channels: next });
                        }}
                        className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border transition-colors ${
                          isActive
                            ? "bg-primary/10 border-primary text-primary"
                            : "bg-card border-border hover:bg-muted"
                        }`}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                  Preview ({current.items.length})
                </p>
                <div className="grid grid-cols-6 gap-1.5 max-h-56 overflow-y-auto">
                  {current.items.slice(0, 24).map((item) => (
                    <div
                      key={item.id}
                      className="aspect-square rounded overflow-hidden bg-neutral-100 dark:bg-neutral-800"
                    >
                      <LazyMedia
                        mediaId={item.id}
                        isVideo={item.content_type.startsWith("video/")}
                        alt={item.filename}
                        className="object-cover w-full h-full"
                      />
                    </div>
                  ))}
                  {current.items.length > 24 && (
                    <div className="aspect-square rounded border border-dashed flex items-center justify-center text-xs text-muted-foreground">
                      +{current.items.length - 24}
                    </div>
                  )}
                </div>
              </div>

              <button
                onClick={() => updateCurrent({ skip: !current.skip })}
                className={`text-xs flex items-center gap-1.5 ${
                  current.skip
                    ? "text-muted-foreground line-through"
                    : "text-primary hover:underline"
                }`}
              >
                <SkipForward className="h-3 w-3" />
                {current.skip ? "Include this shoot" : "Skip this shoot"}
              </button>
            </div>

            <footer className="border-t px-5 py-3 flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setCurrentIdx((i) => Math.max(0, i - 1))
                }
                disabled={currentIdx === 0}
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                Back
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setCurrentIdx((i) => Math.min(shoots.length - 1, i + 1))
                }
                disabled={currentIdx === shoots.length - 1}
              >
                Next
                <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
              <div className="flex-1" />
              <Button onClick={applyAll} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Check className="h-4 w-4 mr-2" />
                )}
                Apply {shoots.filter((s) => !s.skip).length} shoot
                {shoots.filter((s) => !s.skip).length === 1 ? "" : "s"}
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
