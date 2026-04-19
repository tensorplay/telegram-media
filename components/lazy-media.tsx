"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

// Single shared observer so 1000s of tiles don't each create one.
let sharedObserver: IntersectionObserver | null = null;
const subscribers = new WeakMap<Element, () => void>();

function getObserver() {
  if (typeof window === "undefined") return null;
  if (sharedObserver) return sharedObserver;
  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const cb = subscribers.get(entry.target);
          if (cb) {
            cb();
            sharedObserver?.unobserve(entry.target);
            subscribers.delete(entry.target);
          }
        }
      }
    },
    {
      // Start loading a bit before the tile enters the viewport so scrolling
      // feels smooth without prefetching the whole list.
      rootMargin: "300px 0px",
      threshold: 0.01,
    }
  );
  return sharedObserver;
}

const MAX_ATTEMPTS = 3;

export function LazyMedia({
  mediaId,
  isVideo,
  alt,
  className,
  eager = false,
  videoProps,
}: {
  mediaId: string;
  isVideo: boolean;
  alt: string;
  className?: string;
  /** Skip the IntersectionObserver gate — use for viewers where the element
   *  is already on-screen when mounted. */
  eager?: boolean;
  videoProps?: React.VideoHTMLAttributes<HTMLVideoElement>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(eager);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (eager) return;
    const el = containerRef.current;
    if (!el || inView) return;
    const observer = getObserver();
    if (!observer) {
      setInView(true);
      return;
    }
    subscribers.set(el, () => setInView(true));
    observer.observe(el);
    return () => {
      observer.unobserve(el);
      subscribers.delete(el);
    };
  }, [inView, eager]);

  useEffect(() => {
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  function handleError() {
    if (attempt >= MAX_ATTEMPTS - 1) {
      setFailed(true);
      return;
    }
    // 500ms, 1s, 2s backoff — plus a sliver of jitter so many failures
    // don't all retry simultaneously and hammer R2 again.
    const delay = 500 * Math.pow(2, attempt) + Math.random() * 200;
    retryTimer.current = setTimeout(() => {
      setAttempt((a) => a + 1);
    }, delay);
  }

  function manualRetry(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    setFailed(false);
    setAttempt((a) => a + 1);
  }

  // Cache-bust on each retry so the browser doesn't just replay the same
  // failed response.
  const src = `/api/media/${mediaId}${attempt > 0 ? `?r=${attempt}` : ""}`;

  const mediaEl = failed ? (
    <button
      type="button"
      onClick={manualRetry}
      className={`flex flex-col items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors bg-neutral-100 dark:bg-neutral-800 ${
        className ?? "w-full h-full"
      }`}
    >
      <RefreshCw className="h-4 w-4" />
      <span>Retry</span>
    </button>
  ) : isVideo ? (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      key={attempt}
      src={src}
      preload="metadata"
      muted
      playsInline
      className={className}
      onError={handleError}
      {...videoProps}
    />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={attempt}
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onError={handleError}
    />
  );

  // In eager mode the caller sizes/positions the element directly — skip the
  // wrapper div so we don't disturb its layout (used by the fullscreen viewer).
  if (eager) return mediaEl;

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {!inView ? (
        <div className="w-full h-full bg-neutral-100 dark:bg-neutral-800" />
      ) : (
        mediaEl
      )}
    </div>
  );
}
