"use client";

import { useCallback, useEffect, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { X, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MediaItem } from "@/components/media-grid";
import { formatSize } from "@/components/media-grid";

export function MediaViewer({
  media,
  startIndex,
  onClose,
}: {
  media: MediaItem[];
  startIndex: number;
  onClose: () => void;
}) {
  const [emblaRef, emblaApi] = useEmblaCarousel({
    startIndex,
    loop: media.length > 1,
    dragFree: false,
  });

  const [current, setCurrent] = useState(startIndex);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const onSelect = useCallback(() => {
    if (!emblaApi) return;
    setCurrent(emblaApi.selectedScrollSnap());
    setCanPrev(emblaApi.canScrollPrev());
    setCanNext(emblaApi.canScrollNext());
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    onSelect();
    emblaApi.on("select", onSelect);
    emblaApi.on("reInit", onSelect);
    return () => {
      emblaApi.off("select", onSelect);
      emblaApi.off("reInit", onSelect);
    };
  }, [emblaApi, onSelect]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") emblaApi?.scrollPrev();
      if (e.key === "ArrowRight") emblaApi?.scrollNext();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [emblaApi, onClose]);

  const item = media[current];
  const isVideo = item?.content_type.startsWith("video/");

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-sm">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 sm:px-6 text-white/90 shrink-0 safe-area-top">
        <Button
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/10 active:bg-white/20 touch-manipulation h-10 w-10"
          onClick={onClose}
        >
          <X className="h-5 w-5" />
        </Button>
        {media.length > 1 && (
          <span className="text-sm tabular-nums">
            {current + 1} of {media.length}
          </span>
        )}
      </div>

      {/* Carousel */}
      <div className="relative flex-1 min-h-0 flex items-center">
        {/* Previous arrow (desktop) */}
        {media.length > 1 && (
          <button
            onClick={() => emblaApi?.scrollPrev()}
            disabled={!canPrev}
            className="hidden sm:flex absolute left-2 z-10 h-12 w-12 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors disabled:opacity-30 disabled:cursor-default"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}

        <div className="overflow-hidden w-full h-full" ref={emblaRef}>
          <div className="flex h-full touch-pan-y">
            {media.map((slide) => {
              const slideIsVideo = slide.content_type.startsWith("video/");
              return (
                <div
                  key={slide.id}
                  className="flex-[0_0_100%] min-w-0 flex items-center justify-center px-4 sm:px-16"
                >
                  {slideIsVideo ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video
                      src={`/api/media/${slide.id}`}
                      controls
                      playsInline
                      preload="metadata"
                      className="max-w-full max-h-[calc(100vh-10rem)] rounded-lg"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/media/${slide.id}`}
                      alt={slide.filename}
                      className="max-w-full max-h-[calc(100vh-10rem)] rounded-lg object-contain"
                      draggable={false}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Next arrow (desktop) */}
        {media.length > 1 && (
          <button
            onClick={() => emblaApi?.scrollNext()}
            disabled={!canNext}
            className="hidden sm:flex absolute right-2 z-10 h-12 w-12 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors disabled:opacity-30 disabled:cursor-default"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>

      {/* Bottom bar */}
      <div className="px-4 py-3 sm:px-6 text-white/90 shrink-0 safe-area-bottom">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1 mr-4">
            <p className="text-sm font-medium truncate">{item?.filename}</p>
            <p className="text-xs text-white/50">
              {item ? formatSize(item.size_bytes) : ""}
              {isVideo ? " · Video" : ""}
            </p>
          </div>
          {item && (
            <a
              href={`/api/media/${item.id}?download=1`}
              download={item.filename}
              className="inline-flex items-center gap-2 rounded-md bg-white/10 hover:bg-white/20 active:bg-white/25 px-3 py-2 text-sm text-white transition-colors touch-manipulation shrink-0"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">Download</span>
            </a>
          )}
        </div>
        {item?.ai_summary && (
          <p className="text-xs text-white/60 mt-2 line-clamp-3 sm:line-clamp-none">
            {item.ai_summary}
          </p>
        )}
        {item?.ai_tags && item.ai_tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {item.ai_tags.map((tag) => (
              <span
                key={tag}
                className="inline-block px-2 py-0.5 text-[11px] rounded-full bg-white/15 text-white/80"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
