"use client";

import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { GripVertical, Info, Layers } from "lucide-react";
import type { MediaItem } from "@/components/media-grid";
import { LazyMedia } from "@/components/lazy-media";
import { CHANNELS, parseTags, type ChannelValue } from "@/lib/facets";

/**
 * A 3-column Instagram-style grid preview for a channel (or any subset of
 * media). Tiles can be dragged to reorder. Order is persisted as a numeric
 * suffix on the `channel:<name>:<ordering-key>` tag to avoid a schema
 * change; tiles without an explicit key sort by created_at.
 */
export function GridPlanner({
  channel,
  media,
  onMutated,
}: {
  channel: ChannelValue;
  media: (MediaItem & { folder_id?: string | null })[];
  onMutated: () => void;
}) {
  const channelSpec = CHANNELS.find((c) => c.value === channel);
  const aspectClass =
    channelSpec?.aspect === "4:5"
      ? "aspect-[4/5]"
      : channelSpec?.aspect === "9:16"
        ? "aspect-[9/16]"
        : channelSpec?.aspect === "16:9"
          ? "aspect-[16/9]"
          : "aspect-square";

  const ordered = useMemo(() => {
    // Extract ordering key from `channel:<channel>:<ordering-key>` if present.
    return [...media]
      .map((m) => {
        let key: string | null = null;
        for (const t of m.ai_tags ?? []) {
          if (typeof t !== "string") continue;
          const lower = t.toLowerCase();
          const prefix = `channel:${channel}:`;
          if (lower.startsWith(prefix)) {
            key = lower.slice(prefix.length);
            break;
          }
        }
        return { item: m, orderKey: key, created: m.created_at };
      })
      .sort((a, b) => {
        if (a.orderKey && b.orderKey) return a.orderKey.localeCompare(b.orderKey);
        if (a.orderKey && !b.orderKey) return -1;
        if (!a.orderKey && b.orderKey) return 1;
        return b.created.localeCompare(a.created);
      });
  }, [media, channel]);

  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const dragSource = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);

  const displayOrder = useMemo(() => {
    if (localOrder) {
      const map = new Map(ordered.map((o) => [o.item.id, o]));
      return localOrder
        .map((id) => map.get(id))
        .filter((o): o is (typeof ordered)[number] => !!o);
    }
    return ordered;
  }, [ordered, localOrder]);

  function onDragStart(idx: number) {
    dragSource.current = idx;
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
  }
  function onDrop(targetIdx: number) {
    const src = dragSource.current;
    dragSource.current = null;
    if (src === null || src === targetIdx) return;
    const ids = displayOrder.map((o) => o.item.id);
    const [moved] = ids.splice(src, 1);
    ids.splice(targetIdx, 0, moved);
    setLocalOrder(ids);
  }

  async function saveOrder() {
    if (!localOrder) return;
    setSaving(true);
    try {
      // Assign a zero-padded ordering key so lexicographic sort matches
      // numeric. 6 digits handles up to a 999,999-post grid.
      const prefix = `channel:${channel}:`;
      await Promise.all(
        localOrder.map((id, idx) =>
          fetch("/api/tags", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mediaIds: [id],
              clearPrefixes: [prefix],
              add: [`${prefix}${String(idx).padStart(6, "0")}`],
            }),
          })
        )
      );
      setLocalOrder(null);
      onMutated();
    } finally {
      setSaving(false);
    }
  }

  if (displayOrder.length === 0) {
    return (
      <div className="mt-4 text-center text-muted-foreground py-16 border-2 border-dashed rounded-lg">
        <p className="text-lg">Nothing planned for {channelSpec?.label ?? channel}</p>
        <p className="text-sm mt-1">
          Select files in the library and assign them to this channel from the
          inspector.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-medium">
            {channelSpec?.label} — {displayOrder.length} planned
          </p>
          <span className="text-xs text-muted-foreground">
            <Info className="h-3 w-3 inline-block mr-1" />
            Drag tiles to reorder, then save.
          </span>
        </div>
        {localOrder && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLocalOrder(null)}
              disabled={saving}
            >
              Revert
            </Button>
            <Button size="sm" onClick={saveOrder} disabled={saving}>
              Save order
            </Button>
          </div>
        )}
      </div>

      <div className="mx-auto max-w-xl">
        <div className={`grid grid-cols-3 gap-0.5 bg-muted/30 p-0.5 rounded-md`}>
          {displayOrder.map((entry, idx) => {
            const { item } = entry;
            const isVideo = item.content_type.startsWith("video/");
            const { system } = parseTags(item.ai_tags);
            return (
              <div
                key={item.id}
                draggable
                onDragStart={() => onDragStart(idx)}
                onDragOver={onDragOver}
                onDrop={() => onDrop(idx)}
                className={`relative ${aspectClass} bg-neutral-100 dark:bg-neutral-800 overflow-hidden group cursor-grab active:cursor-grabbing`}
              >
                <LazyMedia
                  mediaId={item.id}
                  isVideo={isVideo}
                  alt={item.filename}
                  className="object-cover w-full h-full"
                />
                <div className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <GripVertical className="h-4 w-4 text-white drop-shadow" />
                </div>
                <div className="absolute bottom-1 right-1 text-[9px] text-white bg-black/60 rounded px-1 py-0.5 font-medium tabular-nums">
                  {idx + 1}
                </div>
                {system.hero && (
                  <div className="absolute top-1 right-1 h-4 w-4 rounded-full bg-amber-400 text-white flex items-center justify-center">
                    <svg viewBox="0 0 24 24" fill="currentColor" className="h-2.5 w-2.5">
                      <path d="M12 2l3 6.5L22 9l-5 5 1 7-6-3-6 3 1-7-5-5 7-0.5z" />
                    </svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
