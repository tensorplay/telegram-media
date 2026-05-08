"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { LazyMedia } from "@/components/lazy-media";
import {
  Loader2,
  Sparkles,
  X,
  RotateCcw,
  Image as ImageIcon,
  Video as VideoIcon,
  Save,
  Plus,
  Search,
} from "lucide-react";
import type { MediaItem } from "@/components/media-grid";

const DEFAULT_HEADSWAP_IMAGE_PROMPT =
  "head_swap: Use image 1 as the base image, preserving its environment, background, camera perspective, framing, exposure, contrast, and lighting. Remove the head from image 1 and seamlessly replace it with the head from image 2.\nMatch the original head size, face-to-body ratio, neck thickness, eye direction, shoulder alignment, and camera distance so proportions remain natural and unchanged. make sure to look at the camera.\n\nAdapt the inserted head to the lighting of image 1 by matching light direction, intensity, softness, color temperature, shadows, and highlights, with no independent relighting.\nPreserve the identity of image 2, including hair texture, eye color, nose structure, facial proportions, and skin details.\nMatch the pose and expression from image 1, including head tilt, rotation, eye direction, gaze, micro-expressions, and lip position.\nEnsure seamless neck and jaw blending, consistent skin tone, realistic shadow contact, natural skin texture, and uniform sharpness.\nPhotorealistic, high quality, sharp details, 4K.";

const DEFAULT_HEADSWAP_VIDEO_PROMPT =
  "head_swap:\n\na woman having a serious conversation to another person";

type Mode = "image" | "video";
type Phase =
  | { kind: "idle" }
  | { kind: "uploading-input"; which: "head" | "face" }
  | { kind: "submitting" }
  | { kind: "queued"; promptId: string }
  | { kind: "running"; promptId: string }
  | {
      kind: "done";
      promptId: string;
      output: { filename: string; subfolder: string; type: string; kind: Mode };
    }
  | { kind: "error"; message: string }
  | { kind: "saving" };

interface ComfyGenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creatorId: string;
  creatorSlug: string;
  /** All media for this creator, used as the source for the library picker. */
  media: MediaItem[];
  /** Pre-fill the body slot if non-null (and content type matches the mode). */
  defaultBodyMediaId?: string | null;
  /** Called after a successful "Save to library". */
  onSaved?: () => void;
}

export function ComfyGenerateDialog({
  open,
  onOpenChange,
  creatorId,
  creatorSlug,
  media,
  defaultBodyMediaId,
  onSaved,
}: ComfyGenerateDialogProps) {
  const [mode, setMode] = useState<Mode>("image");
  const [headMediaId, setHeadMediaId] = useState<string | null>(null);
  const [faceMediaId, setFaceMediaId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>(DEFAULT_HEADSWAP_IMAGE_PROMPT);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [picker, setPicker] = useState<"body" | "face" | null>(null);

  // Track polling so it can be cancelled when the dialog closes / re-runs.
  const pollAbort = useRef<{ cancelled: boolean } | null>(null);

  const headItem = useMemo(
    () => (headMediaId ? media.find((m) => m.id === headMediaId) ?? null : null),
    [headMediaId, media]
  );
  const faceItem = useMemo(
    () => (faceMediaId ? media.find((m) => m.id === faceMediaId) ?? null : null),
    [faceMediaId, media]
  );

  // Reset prompt + clear inputs when the user changes mode.
  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return;
      setMode(next);
      setHeadMediaId(null);
      setPhase({ kind: "idle" });
      setPrompt(
        next === "image"
          ? DEFAULT_HEADSWAP_IMAGE_PROMPT
          : DEFAULT_HEADSWAP_VIDEO_PROMPT
      );
    },
    [mode]
  );

  // Pre-fill body slot if compatible with the current mode.
  useEffect(() => {
    if (!open || !defaultBodyMediaId) return;
    const item = media.find((m) => m.id === defaultBodyMediaId);
    if (!item) return;
    const ok =
      (mode === "image" && item.content_type.startsWith("image/")) ||
      (mode === "video" && item.content_type.startsWith("video/"));
    if (ok) setHeadMediaId(defaultBodyMediaId);
  }, [open, defaultBodyMediaId, media, mode]);

  // Reset everything when the dialog closes.
  useEffect(() => {
    if (open) return;
    if (pollAbort.current) pollAbort.current.cancelled = true;
    setHeadMediaId(null);
    setFaceMediaId(null);
    setPhase({ kind: "idle" });
    setPicker(null);
    setMode("image");
    setPrompt(DEFAULT_HEADSWAP_IMAGE_PROMPT);
  }, [open]);

  const canGenerate =
    !!headMediaId &&
    !!faceMediaId &&
    prompt.trim().length > 0 &&
    (phase.kind === "idle" || phase.kind === "error" || phase.kind === "done");

  // ------- Generate / poll -----------------------------------------------
  const runGenerate = useCallback(
    async (seed?: number) => {
      if (!headMediaId || !faceMediaId) return;
      if (pollAbort.current) pollAbort.current.cancelled = true;
      const abort = { cancelled: false };
      pollAbort.current = abort;
      setPhase({ kind: "submitting" });
      try {
        const res = await fetch("/api/comfy/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            creatorId,
            mode,
            headMediaId,
            faceMediaId,
            prompt,
            seed,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        const promptId = data.promptId as string;
        setPhase({ kind: "queued", promptId });

        const interval = mode === "image" ? 3000 : 8000;
        let firstPoll = true;
        while (!abort.cancelled) {
          await sleep(firstPoll ? 1500 : interval);
          firstPoll = false;
          if (abort.cancelled) return;
          const sRes = await fetch(
            `/api/comfy/status?promptId=${encodeURIComponent(promptId)}&mode=${mode}`,
            { cache: "no-store" }
          );
          const sData = await sRes.json();
          if (!sRes.ok) {
            throw new Error(sData.error ?? `Status HTTP ${sRes.status}`);
          }
          if (sData.status === "running") {
            setPhase((p) =>
              p.kind === "queued" || p.kind === "running"
                ? { kind: "running", promptId }
                : p
            );
            continue;
          }
          if (sData.status === "error") {
            throw new Error(sData.error ?? "ComfyUI reported an error");
          }
          if (sData.status === "done" && sData.output) {
            setPhase({ kind: "done", promptId, output: sData.output });
            return;
          }
        }
      } catch (err) {
        if (abort.cancelled) return;
        const message = err instanceof Error ? err.message : "Generate failed";
        setPhase({ kind: "error", message });
      }
    },
    [headMediaId, faceMediaId, creatorId, mode, prompt]
  );

  // Cancel polling on unmount.
  useEffect(() => {
    return () => {
      if (pollAbort.current) pollAbort.current.cancelled = true;
    };
  }, []);

  // ------- Save -----------------------------------------------------------
  const handleSave = useCallback(async () => {
    if (phase.kind !== "done") return;
    setPhase({ kind: "saving" });
    try {
      const res = await fetch("/api/comfy/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorId,
          creatorSlug,
          mode,
          filename: phase.output.filename,
          subfolder: phase.output.subfolder,
          type: phase.output.type,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed";
      setPhase({ kind: "error", message });
    }
  }, [phase, creatorId, creatorSlug, mode, onOpenChange, onSaved]);

  const previewUrl =
    phase.kind === "done"
      ? buildPreviewUrl(phase.output)
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-w-[calc(100%-1rem)] p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Generate (ComfyUI)
          </DialogTitle>
        </DialogHeader>

        <div className="px-5 pb-5 pt-1 space-y-4 max-h-[80vh] overflow-y-auto">
          {/* Mode toggle */}
          <div className="inline-flex rounded-lg border bg-muted/30 p-0.5">
            <ModeTab
              active={mode === "image"}
              onClick={() => switchMode("image")}
              icon={<ImageIcon className="h-3.5 w-3.5" />}
            >
              Image (Flux 2)
            </ModeTab>
            <ModeTab
              active={mode === "video"}
              onClick={() => switchMode("video")}
              icon={<VideoIcon className="h-3.5 w-3.5" />}
            >
              Video (LTX 2.3)
            </ModeTab>
          </div>

          {/* Slots */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Slot
              label="Body (head input)"
              hint={
                mode === "image"
                  ? "Photo with the body / scene where the head will be replaced"
                  : "Video with the body / performance"
              }
              accept={mode === "image" ? "image" : "video"}
              item={headItem}
              onPick={() => setPicker("body")}
              onClear={() => setHeadMediaId(null)}
              onUploaded={(id) => setHeadMediaId(id)}
              creatorSlug={creatorSlug}
              creatorId={creatorId}
            />
            <Slot
              label="Face (face input)"
              hint="Still photo of the face/head you want to swap onto the body"
              accept="image"
              item={faceItem}
              onPick={() => setPicker("face")}
              onClear={() => setFaceMediaId(null)}
              onUploaded={(id) => setFaceMediaId(id)}
              creatorSlug={creatorSlug}
              creatorId={creatorId}
            />
          </div>

          {/* Prompt */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                Prompt
              </label>
              <button
                type="button"
                onClick={() =>
                  setPrompt(
                    mode === "image"
                      ? DEFAULT_HEADSWAP_IMAGE_PROMPT
                      : DEFAULT_HEADSWAP_VIDEO_PROMPT
                  )
                }
                className="text-[11px] text-primary inline-flex items-center gap-1 hover:underline"
              >
                <RotateCcw className="h-3 w-3" />
                Reset to default
              </button>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={mode === "image" ? 6 : 3}
              className="w-full rounded-md border bg-background p-2 text-xs leading-relaxed font-mono resize-y min-h-[80px]"
              placeholder="Describe the swap..."
            />
          </div>

          {/* Phase / Generate / Result */}
          <PhasePanel
            phase={phase}
            mode={mode}
            previewUrl={previewUrl}
            canGenerate={canGenerate}
            onGenerate={() => runGenerate()}
            onRegenerate={() => runGenerate()}
            onSave={handleSave}
            onDiscard={() => onOpenChange(false)}
          />
        </div>

        {picker && (
          <LibraryPicker
            media={media}
            accept={picker === "body" ? (mode === "image" ? "image" : "video") : "image"}
            onPick={(id) => {
              if (picker === "body") setHeadMediaId(id);
              else setFaceMediaId(id);
              setPicker(null);
            }}
            onClose={() => setPicker(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// Sub-components
// ===========================================================================

function ModeTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
        active
          ? "bg-background shadow-sm text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

interface SlotProps {
  label: string;
  hint: string;
  accept: "image" | "video";
  item: MediaItem | null;
  onPick: () => void;
  onClear: () => void;
  onUploaded: (mediaId: string) => void;
  creatorSlug: string;
  creatorId: string;
}

function Slot({
  label,
  hint,
  accept,
  item,
  onPick,
  onClear,
  onUploaded,
  creatorSlug,
  creatorId,
}: SlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acceptString =
    accept === "image"
      ? "image/jpeg,image/png,image/webp,image/gif"
      : "video/mp4,video/quicktime,video/webm";

  const handleFile = useCallback(
    async (file: File) => {
      const okType =
        accept === "image"
          ? file.type.startsWith("image/")
          : file.type.startsWith("video/");
      if (!okType) {
        setError(`Expected ${accept}`);
        return;
      }
      setError(null);
      setUploading(true);
      try {
        const signRes = await fetch("/api/upload", {
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
        const signData = await signRes.json();
        if (!signRes.ok) throw new Error(signData.error ?? `HTTP ${signRes.status}`);
        const { uploadUrl, mediaId } = signData as {
          uploadUrl: string;
          mediaId: string;
        };
        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!putRes.ok) throw new Error(`R2 upload failed (${putRes.status})`);
        // Fire-and-forget analyze so the new file gets tags eventually.
        fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaId }),
          keepalive: true,
        }).catch(() => {});
        onUploaded(mediaId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [accept, creatorSlug, creatorId, onUploaded]
  );

  const isVideo = item?.content_type.startsWith("video/") ?? false;

  return (
    <div className="border rounded-lg overflow-hidden bg-muted/20">
      <div className="px-3 py-2 border-b bg-muted/30 flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold truncate">{label}</p>
          <p className="text-[10px] text-muted-foreground truncate">{hint}</p>
        </div>
        {item && (
          <button
            type="button"
            onClick={onClear}
            className="text-muted-foreground hover:text-destructive shrink-0"
            title="Clear"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {item ? (
        <div className="aspect-square bg-neutral-100 dark:bg-neutral-800 relative">
          <LazyMedia
            mediaId={item.id}
            isVideo={isVideo}
            alt={item.filename}
            className="object-cover w-full h-full"
            videoProps={{ loop: true, autoPlay: true, muted: true }}
          />
          <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-gradient-to-t from-black/70 to-transparent">
            <p className="text-[10px] text-white truncate">{item.filename}</p>
          </div>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleFile(file);
          }}
          className={`aspect-square flex flex-col items-center justify-center gap-2 p-4 transition-colors ${
            dragOver ? "bg-primary/10" : ""
          }`}
        >
          {uploading ? (
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          ) : (
            <>
              <p className="text-xs text-muted-foreground text-center">
                Drop {accept === "image" ? "an image" : "a video"} here
              </p>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onPick}
                >
                  <Search className="h-3 w-3 mr-1" />
                  Library
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => inputRef.current?.click()}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Upload
                </Button>
                <input
                  ref={inputRef}
                  type="file"
                  className="hidden"
                  accept={acceptString}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                    e.target.value = "";
                  }}
                />
              </div>
            </>
          )}
          {error && (
            <p className="text-[10px] text-destructive text-center">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}

interface LibraryPickerProps {
  media: MediaItem[];
  accept: "image" | "video";
  onPick: (id: string) => void;
  onClose: () => void;
}

function LibraryPicker({ media, accept, onPick, onClose }: LibraryPickerProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return media
      .filter((m) =>
        accept === "image"
          ? m.content_type.startsWith("image/")
          : m.content_type.startsWith("video/")
      )
      .filter(
        (m) =>
          !q ||
          m.filename.toLowerCase().includes(q) ||
          (m.ai_tags ?? []).some((t) => t.toLowerCase().includes(q))
      )
      .slice(0, 240);
  }, [media, accept, query]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[80vh] flex flex-col rounded-lg border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <p className="text-sm font-semibold flex-1">
            Pick {accept === "image" ? "an image" : "a video"} from library
          </p>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search filename or tag..."
            className="h-7 rounded-md border bg-background px-2 text-xs w-44"
            autoFocus
          />
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">
              No {accept === "image" ? "images" : "videos"} match.
            </p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
              {filtered.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onPick(m.id)}
                  className="group relative aspect-square overflow-hidden rounded-md bg-neutral-100 dark:bg-neutral-800 ring-2 ring-transparent hover:ring-primary transition-all"
                  title={m.filename}
                >
                  <LazyMedia
                    mediaId={m.id}
                    isVideo={m.content_type.startsWith("video/")}
                    alt={m.filename}
                    className="object-cover w-full h-full"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface PhasePanelProps {
  phase: Phase;
  mode: Mode;
  previewUrl: string | null;
  canGenerate: boolean;
  onGenerate: () => void;
  onRegenerate: () => void;
  onSave: () => void;
  onDiscard: () => void;
}

function PhasePanel({
  phase,
  mode,
  previewUrl,
  canGenerate,
  onGenerate,
  onRegenerate,
  onSave,
  onDiscard,
}: PhasePanelProps) {
  const inFlight =
    phase.kind === "submitting" ||
    phase.kind === "queued" ||
    phase.kind === "running" ||
    phase.kind === "saving";

  if (phase.kind === "done" && previewUrl) {
    return (
      <div className="space-y-2">
        <div className="rounded-lg overflow-hidden border bg-neutral-100 dark:bg-neutral-900 max-h-[50vh] flex items-center justify-center">
          {phase.output.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt="Generated result"
              className="max-h-[50vh] w-auto object-contain"
            />
          ) : (
            <video
              src={previewUrl}
              controls
              autoPlay
              loop
              muted
              playsInline
              className="max-h-[50vh] w-auto"
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onSave} size="sm">
            <Save className="h-3.5 w-3.5 mr-1.5" />
            Save to library
          </Button>
          <Button onClick={onRegenerate} size="sm" variant="outline">
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            Generate another
          </Button>
          <div className="flex-1" />
          <Button onClick={onDiscard} size="sm" variant="ghost">
            Discard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          onClick={onGenerate}
          disabled={!canGenerate || inFlight}
          size="default"
        >
          {inFlight ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
          ) : (
            <Sparkles className="h-4 w-4 mr-1.5" />
          )}
          {phaseLabel(phase, mode)}
        </Button>
        {mode === "video" && phase.kind !== "error" && (
          <span className="text-[11px] text-muted-foreground">
            Video runs can take several minutes.
          </span>
        )}
      </div>
      {phase.kind === "error" && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          {phase.message}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

function phaseLabel(phase: Phase, mode: Mode): string {
  switch (phase.kind) {
    case "idle":
    case "error":
      return mode === "image" ? "Generate image" : "Generate video";
    case "submitting":
      return "Uploading to ComfyUI...";
    case "queued":
      return "In queue...";
    case "running":
      return "Sampling...";
    case "saving":
      return "Saving...";
    case "done":
      return "Done";
    default:
      return "Generate";
  }
}

function buildPreviewUrl(out: {
  filename: string;
  subfolder: string;
  type: string;
}): string {
  const params = new URLSearchParams({
    filename: out.filename,
    type: out.type,
  });
  if (out.subfolder) params.set("subfolder", out.subfolder);
  return `/api/comfy/preview?${params.toString()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
