/**
 * Thin client for the ComfyUI HTTP API plus workflow builders for our two
 * supported pipelines:
 *
 *   - Image head swap (Flux 2 Klein)  -> SaveImage node "9"
 *   - Video head swap (LTX 2.3)       -> VHS_VideoCombine node "410"
 *
 * Both workflows take a body input (image or video) and a face input (image),
 * a free-form prompt, and a seed. The builders deep-clone the imported JSON
 * template and substitute only the fields we care about so the rest of the
 * graph (samplers, VAEs, LoRAs, etc.) stays untouched.
 *
 * Image and video uploads both go through `/upload/image` — ComfyUI just
 * writes whatever bytes you send into the `input/` folder, and VHS_LoadVideo
 * reads videos from there.
 */
import imageWorkflowTemplate from "@/lib/comfy/workflows/face-swap.json";
import videoWorkflowTemplate from "@/lib/comfy/workflows/video-face-swap.json";

export const COMFY_URL =
  process.env.COMFY_URL?.replace(/\/$/, "") ?? "http://64.135.236.83:8188";

export type ComfyMode = "image" | "video";

// Workflow nodes are typed loosely — we only ever read/write nested input
// fields by string key, and the JSON shape is defined by the template files.
type WorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};
export type Workflow = Record<string, WorkflowNode>;

export interface ComfyOutputRef {
  filename: string;
  subfolder: string;
  type: string; // "output" | "temp" | "input"
}

export const DEFAULT_HEADSWAP_IMAGE_PROMPT =
  (imageWorkflowTemplate as Workflow)["107"].inputs.text as string;

export const DEFAULT_HEADSWAP_VIDEO_PROMPT =
  (videoWorkflowTemplate as Workflow)["445"].inputs.value as string;

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

/**
 * Upload bytes (image or video) to ComfyUI's input folder. Same endpoint for
 * both — VHS_LoadVideo just reads files written here.
 *
 * Comfy's /upload/image returns `{ name, subfolder, type }`, while history /
 * view both use `{ filename, subfolder, type }`. We normalize on the
 * `filename` shape internally so the rest of the code is consistent.
 */
export async function uploadInput(
  buffer: Buffer | Uint8Array,
  filename: string,
  mime: string
): Promise<ComfyOutputRef> {
  const form = new FormData();
  // Re-allocate into a plain ArrayBuffer-backed Uint8Array so the Blob
  // constructor accepts it under strict TS lib types (Buffer is backed by
  // ArrayBufferLike which is a wider union).
  const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const bytes = new Uint8Array(src.byteLength);
  bytes.set(src);
  form.append("image", new Blob([bytes], { type: mime }), filename);
  form.append("type", "input");
  form.append("overwrite", "true");

  const res = await fetch(`${COMFY_URL}/upload/image`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Comfy upload failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    name?: string;
    filename?: string;
    subfolder?: string;
    type?: string;
  };
  return {
    filename: data.name ?? data.filename ?? filename,
    subfolder: data.subfolder ?? "",
    type: data.type ?? "input",
  };
}

export async function queuePrompt(workflow: Workflow): Promise<string> {
  const res = await fetch(`${COMFY_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: cryptoId() }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Comfy /prompt failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    prompt_id?: string;
    node_errors?: Record<string, unknown>;
    error?: unknown;
  };
  if (data.node_errors && Object.keys(data.node_errors).length > 0) {
    throw new Error(
      `Comfy node errors: ${JSON.stringify(data.node_errors).slice(0, 600)}`
    );
  }
  if (!data.prompt_id) {
    throw new Error(`Comfy returned no prompt_id: ${JSON.stringify(data)}`);
  }
  return data.prompt_id;
}

export interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
  outputs?: Record<
    string,
    {
      images?: ComfyOutputRef[];
      gifs?: ComfyOutputRef[];
      videos?: ComfyOutputRef[];
    } & Record<string, unknown>
  >;
}

export async function getHistory(promptId: string): Promise<HistoryEntry | null> {
  const res = await fetch(`${COMFY_URL}/history/${encodeURIComponent(promptId)}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Comfy /history failed (${res.status})`);
  }
  const data = (await res.json()) as Record<string, HistoryEntry>;
  const entry = data[promptId];
  return entry ?? null;
}

/** Stream the bytes for a given output reference back to the caller. */
export async function viewBuffer(ref: ComfyOutputRef): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  const url = new URL(`${COMFY_URL}/view`);
  url.searchParams.set("filename", ref.filename);
  if (ref.subfolder) url.searchParams.set("subfolder", ref.subfolder);
  url.searchParams.set("type", ref.type || "output");

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Comfy /view failed (${res.status})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType =
    res.headers.get("content-type") ??
    guessMimeFromName(ref.filename) ??
    "application/octet-stream";
  return { buffer, contentType };
}

// ---------------------------------------------------------------------------
// Workflow builders
// ---------------------------------------------------------------------------

export interface BuildImageOpts {
  bodyImage: string;
  faceImage: string;
  prompt: string;
  seed?: number;
}

export function buildHeadSwapImageWorkflow(opts: BuildImageOpts): Workflow {
  const wf = clone(imageWorkflowTemplate as Workflow);
  // Node 151 = base body image (the "head input" the user picks).
  wf["151"].inputs.image = opts.bodyImage;
  // Node 121 = source face/head image.
  wf["121"].inputs.image = opts.faceImage;
  // Node 107 = positive prompt (CLIPTextEncode).
  wf["107"].inputs.text = opts.prompt;
  // Node 156 = LanPaint KSampler (seeded sampler).
  wf["156"].inputs.seed = opts.seed ?? randomSeed();
  return wf;
}

export interface BuildVideoOpts {
  bodyVideo: string;
  faceImage: string;
  prompt: string;
  seed?: number;
}

export function buildHeadSwapVideoWorkflow(opts: BuildVideoOpts): Workflow {
  const wf = clone(videoWorkflowTemplate as Workflow);
  // Node 372 = VHS_LoadVideo (the body performance video).
  wf["372"].inputs.video = opts.bodyVideo;
  // Node 269 = LoadImage (the source face still).
  wf["269"].inputs.image = opts.faceImage;
  // Node 445 = manual prompt (PrimitiveStringMultiline).
  wf["445"].inputs.value = opts.prompt;
  // Node 446 = "Enhanced Prompt" switch — keep it false so 445's manual
  // prompt is what reaches the CLIP encoder, not the auto Gemma describer.
  wf["446"].inputs.switch = false;
  // Node 282 = RandomNoise (seed).
  wf["282"].inputs.noise_seed = opts.seed ?? randomSeed();
  return wf;
}

// ---------------------------------------------------------------------------
// Output extraction
// ---------------------------------------------------------------------------

export type OutputKind = "image" | "video";

export interface ExtractedOutput {
  ref: ComfyOutputRef;
  kind: OutputKind;
}

const OUTPUT_NODE_BY_MODE: Record<ComfyMode, string> = {
  image: "9",
  video: "410",
};

/**
 * Find the saved output for a completed history entry. VHS stores mp4s under
 * `gifs` (legacy quirk); falls back to `videos` and `images` in case a future
 * VHS version moves things around.
 */
export function extractOutput(
  history: HistoryEntry | null,
  mode: ComfyMode
): ExtractedOutput | null {
  if (!history?.outputs) return null;
  const node = OUTPUT_NODE_BY_MODE[mode];
  const out = history.outputs[node];
  if (!out) return null;

  if (mode === "image") {
    const ref = pickFirst(out.images);
    return ref ? { ref, kind: "image" } : null;
  }

  // video mode
  const ref = pickFirst(out.gifs) ?? pickFirst(out.videos) ?? pickFirst(out.images);
  return ref ? { ref, kind: "video" } : null;
}

/**
 * Returns one of: "running" | "done" | "error". Comfy's history endpoint
 * returns nothing for queued/running prompts, so absence == still working.
 * `status_str === "error"` is the explicit failure case.
 */
export function statusFromHistory(history: HistoryEntry | null): {
  status: "running" | "done" | "error";
  message?: string;
} {
  if (!history) return { status: "running" };
  const s = history.status?.status_str;
  if (s === "error") {
    const msg = serializeError(history.status?.messages);
    return { status: "error", message: msg };
  }
  if (history.status?.completed === false) return { status: "running" };
  return { status: "done" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function randomSeed(): number {
  // ComfyUI accepts up to 2^53-1 but most samplers cap at 2^32 — staying in
  // the safe int range avoids surprises across nodes.
  return Math.floor(Math.random() * 0xffffffff);
}

function pickFirst(arr: ComfyOutputRef[] | undefined): ComfyOutputRef | undefined {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : undefined;
}

function cryptoId(): string {
  // crypto.randomUUID is available in Node 20+ and the Edge runtime.
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function serializeError(messages: unknown): string {
  if (!Array.isArray(messages)) return "Comfy reported an error";
  for (const m of messages) {
    if (Array.isArray(m) && m.length >= 2) {
      const [tag, payload] = m as [string, unknown];
      if (tag === "execution_error" && payload && typeof payload === "object") {
        const p = payload as Record<string, unknown>;
        const node = p.node_type ?? p.node_id ?? "unknown node";
        const err = p.exception_message ?? p.exception_type ?? "unknown error";
        return `${node}: ${err}`;
      }
    }
  }
  return "Comfy reported an error";
}

function guessMimeFromName(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    default:
      return null;
  }
}
