// telegram-media/lib/media-analysis/r2/r2-cache-core.ts
// ----------------------------------------------------------------------
// R2 Cache Core
// - Shared R2 client and configuration
// - SHA-256 deduplication
// - Upload health verification
// - Presigned GET URLs
// - Metadata touch through self-copy
// - Lazy TTL cleanup
// ----------------------------------------------------------------------

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const DAY_MS = 24 * 60 * 60 * 1000;

export type R2MediaKind = "frame" | "video" | "subclip";

export type R2Config = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  presignExpires: number;
  ttlMs: number;
};

export type R2LogEvent =
  | "CACHE_BYPASS"
  | "CACHE_HIT_BUT_CORRUPT_REUPLOAD"
  | "CACHE_HIT"
  | "TOUCH_OK"
  | "TOUCH_SKIP"
  | "UPLOAD_CACHE_BYPASS"
  | "CACHE_MISS_UPLOAD"
  | "UPLOAD_OK"
  | "CLEANUP_DELETE"
  | "CLEANUP_WARN"
  | "CLEANUP_FAILED";

export type R2LogData = {
  logTag?: string;
  kind?: R2MediaKind;
  key?: string;
  sha256?: string;
  localBytes?: number;
  remoteBytes?: number;
  uploadedBytes?: number;
  minBytes?: number;
  reason?: string;
  err?: string;
  msg?: string;
};

export type R2Logger = (
  event: R2LogEvent,
  data: R2LogData
) => void;

export type R2KeyBuilderArgs = {
  prefix: string;
  sha256: string;
  filename: string;
  kind: R2MediaKind;
};

export type R2KeyBuilder = (
  args: R2KeyBuilderArgs
) => string;

export type R2CleanupPrefixBuilderArgs = {
  prefix: string;
  sha256: string;
  key: string;
  kind: R2MediaKind;
};

export type R2CleanupPrefixBuilder = (
  args: R2CleanupPrefixBuilderArgs
) => string;

export type PublishAndPresignInput = {
  kind: R2MediaKind;
  filePath: string;
  filename: string;
  contentType?: string;
  minBytes?: number;

  keyBuilder?: R2KeyBuilder;
  cleanupPrefixBuilder?: R2CleanupPrefixBuilder;

  cleanupPrefix?: string;
  cleanupTtlMs?: number;

  disableCache?: boolean;
  disableTouch?: boolean;
  presignExpiresIn?: number;

  logTag?: string;
  log?: R2Logger;
};

export type PublishAndPresignResult = {
  sha256: string;
  key: string;
  url: string;
  bytes: number;
  remoteBytes: number;
  wasReuploaded: boolean;
};

type HeadObjectSafeResult =
  | {
      exists: true;
      head: HeadObjectCommandOutput;
      contentLength: number;
    }
  | {
      exists: false;
      head: null;
      contentLength: 0;
    };

type MetadataInput = Record<
  string,
  string | number | boolean | null | undefined
>;

type EnsureUploadedAndHealthyInput = {
  key: string;
  filePath: string;
  contentType: string;
  minBytes?: number;
  disableCache?: boolean;
  disableTouch?: boolean;
  logTag?: string;
  log?: R2Logger;
};

type EnsureUploadedAndHealthyResult = {
  exists: true;
  remoteBytes: number;
  uploadedBytes: number | null;
  wasReuploaded: boolean;
};

type CleanupExpiredObjectsInput = {
  client: S3Client;
  bucket: string;
  prefix: string;
  ttlMs?: number;
  onDelete?: (key: string) => void;
  onWarn?: (data: { key: string; err: string }) => void;
};

type CleanupExpiredObjectsResult = {
  scanned: number;
  deleted: number;
};

type ComputeHashAndKeyInput = {
  kind: R2MediaKind;
  filePath: string;
  filename: string;
  prefix?: string;
  keyBuilder?: R2KeyBuilder;
};

type ComputeHashAndKeyResult = {
  sha256: string;
  key: string;
};

function getErrorName(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error
  ) {
    return String(error.name || "");
  }

  return "";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function getHttpStatusCode(
  error: unknown
): number | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("$metadata" in error)
  ) {
    return null;
  }

  const metadata = (
    error as {
      $metadata?: {
        httpStatusCode?: number;
      };
    }
  ).$metadata;

  return typeof metadata?.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : null;
}

function isNotFoundError(error: unknown): boolean {
  const statusCode = getHttpStatusCode(error);
  const errorName = getErrorName(error).toLowerCase();

  return (
    statusCode === 404 ||
    errorName.includes("notfound") ||
    errorName.includes("nosuchkey")
  );
}

function normalizeMetadata(
  metadata: MetadataInput = {}
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) {
      continue;
    }

    normalized[String(key)] = String(value);
  }

  return normalized;
}

function encodeCopySource(
  bucket: string,
  key: string
): string {
  return `${encodeURIComponent(bucket)}/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function normalizePositiveNumber(
  value: unknown,
  fallback: number
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

// --------------------------------------------------
// Small utilities
// --------------------------------------------------

export function envTrue(name: string): boolean {
  const value = String(process.env[name] ?? "")
    .toLowerCase()
    .trim();

  return (
    value === "1" ||
    value === "true" ||
    value === "yes" ||
    value === "on"
  );
}

export function safeTrunc(
  value: unknown,
  maxLength = 400
): string {
  return String(value ?? "").slice(0, maxLength);
}

export function nowMs(): number {
  return Date.now();
}

// --------------------------------------------------
// Configuration
// --------------------------------------------------

export function getR2Config(): R2Config {
  const {
    R2_ENDPOINT,
    R2_BUCKET,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
  } = process.env;

  if (!R2_ENDPOINT) {
    throw new Error("Missing R2_ENDPOINT");
  }

  if (!R2_BUCKET) {
    throw new Error("Missing R2_BUCKET");
  }

  if (!R2_ACCESS_KEY_ID) {
    throw new Error("Missing R2_ACCESS_KEY_ID");
  }

  if (!R2_SECRET_ACCESS_KEY) {
    throw new Error("Missing R2_SECRET_ACCESS_KEY");
  }

  const prefix =
    String(process.env.R2_MEDIA_PREFIX || "media")
      .trim()
      .replace(/^\/+|\/+$/g, "") || "media";

  const presignExpires = normalizePositiveNumber(
    process.env.R2_PRESIGN_EXPIRES,
    604800
  );

  const ttlDays = normalizePositiveNumber(
    process.env.R2_TTL_DAYS,
    7
  );

  return {
    endpoint: R2_ENDPOINT,
    bucket: R2_BUCKET,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    prefix,
    presignExpires,
    ttlMs: Math.max(1, ttlDays) * DAY_MS,
  };
}

// --------------------------------------------------
// Content type
// --------------------------------------------------

function defaultContentType({
  kind,
  filename,
  contentType,
}: {
  kind: R2MediaKind;
  filename: string;
  contentType?: string;
}): string {
  const explicitContentType =
    String(contentType || "").trim();

  if (explicitContentType) {
    return explicitContentType;
  }

  const extension = path
    .extname(String(filename || ""))
    .toLowerCase();

  if (
    extension === ".jpg" ||
    extension === ".jpeg"
  ) {
    return "image/jpeg";
  }

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  if (extension === ".gif") {
    return "image/gif";
  }

  if (extension === ".mp4") {
    return "video/mp4";
  }

  if (extension === ".mov") {
    return "video/quicktime";
  }

  if (extension === ".webm") {
    return "video/webm";
  }

  if (extension === ".mkv") {
    return "video/x-matroska";
  }

  if (kind === "frame") {
    return "image/jpeg";
  }

  return "video/mp4";
}

// --------------------------------------------------
// Client singleton
// --------------------------------------------------

let r2Client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (r2Client) {
    return r2Client;
  }

  const config = getR2Config();

  r2Client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return r2Client;
}

// --------------------------------------------------
// Hash
// --------------------------------------------------

export async function sha256File(
  filePath: string
): Promise<string> {
  if (!filePath) {
    throw new Error("sha256File: filePath is required");
  }

  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

// --------------------------------------------------
// Head
// --------------------------------------------------

export async function headObjectSafe(
  client: S3Client,
  bucket: string,
  key: string
): Promise<HeadObjectSafeResult> {
  try {
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    return {
      exists: true,
      head,
      contentLength: Number(head.ContentLength || 0),
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        exists: false,
        head: null,
        contentLength: 0,
      };
    }

    throw error;
  }
}

// --------------------------------------------------
// Upload and touch
// --------------------------------------------------

export async function uploadWithMetadata({
  client,
  bucket,
  key,
  filePath,
  contentType,
  metadata = {},
}: {
  client: S3Client;
  bucket: string;
  key: string;
  filePath: string;
  contentType: string;
  metadata?: MetadataInput;
}): Promise<number> {
  const stat = await fs.promises.stat(filePath);

  if (!stat.isFile()) {
    throw new Error(
      `uploadWithMetadata: not a regular file: ${filePath}`
    );
  }

  const body = fs.createReadStream(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: stat.size,
      Metadata: {
        "last-accessed-at": String(nowMs()),
        ...normalizeMetadata(metadata),
      },
    })
  );

  return stat.size;
}

export async function touchMetadata({
  client,
  bucket,
  key,
  metadata = {},
}: {
  client: S3Client;
  bucket: string;
  key: string;
  metadata?: MetadataInput;
}): Promise<void> {
  const existing = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: key,
      CopySource: encodeCopySource(bucket, key),

      /*
       * MetadataDirective=REPLACE requires us to explicitly preserve relevant
       * headers and existing custom metadata.
       */
      ContentType: existing.ContentType,
      CacheControl: existing.CacheControl,
      ContentDisposition: existing.ContentDisposition,
      ContentEncoding: existing.ContentEncoding,
      ContentLanguage: existing.ContentLanguage,

      Metadata: {
        ...(existing.Metadata || {}),
        "last-accessed-at": String(nowMs()),
        ...normalizeMetadata(metadata),
      },

      MetadataDirective: "REPLACE",
    })
  );
}

// --------------------------------------------------
// Presigned GET
// --------------------------------------------------

export async function presignGet({
  client,
  bucket,
  key,
  expiresIn,
}: {
  client: S3Client;
  bucket: string;
  key: string;
  expiresIn?: number;
}): Promise<string> {
  const config = getR2Config();

  const expiration = normalizePositiveNumber(
    expiresIn,
    config.presignExpires
  );

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    {
      expiresIn: expiration,
    }
  );
}

// --------------------------------------------------
// Lazy TTL cleanup
// --------------------------------------------------

export async function cleanupExpiredObjects({
  client,
  bucket,
  prefix,
  ttlMs,
  onDelete,
  onWarn,
}: CleanupExpiredObjectsInput): Promise<CleanupExpiredObjectsResult> {
  const config = getR2Config();
  const effectiveTtlMs = normalizePositiveNumber(
    ttlMs,
    config.ttlMs
  );

  const currentTime = nowMs();

  let continuationToken: string | undefined;
  let scanned = 0;
  let deleted = 0;

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects = list.Contents || [];
    scanned += objects.length;

    for (const object of objects) {
      const key = object.Key;

      if (!key) {
        continue;
      }

      try {
        const head = await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
          })
        );

        const lastAccessedAt = Number(
          head.Metadata?.["last-accessed-at"] || 0
        );

        const expired =
          !lastAccessedAt ||
          currentTime - lastAccessedAt > effectiveTtlMs;

        if (!expired) {
          continue;
        }

        onDelete?.(key);

        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
          })
        );

        deleted += 1;
      } catch (error) {
        onWarn?.({
          key,
          err: safeTrunc(getErrorMessage(error), 300),
        });
      }
    }

    continuationToken = list.IsTruncated
      ? list.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return {
    scanned,
    deleted,
  };
}

// --------------------------------------------------
// Upload health
// --------------------------------------------------

export async function ensureUploadedAndHealthy({
  key,
  filePath,
  contentType,
  minBytes = 0,
  disableCache = false,
  disableTouch = false,
  logTag = "R2",
  log,
}: EnsureUploadedAndHealthyInput): Promise<EnsureUploadedAndHealthyResult> {
  if (!key) {
    throw new Error(
      "ensureUploadedAndHealthy: key is required"
    );
  }

  if (!filePath) {
    throw new Error(
      "ensureUploadedAndHealthy: filePath is required"
    );
  }

  const config = getR2Config();
  const client = getR2Client();
  const bucket = config.bucket;

  const stat = await fs.promises.stat(filePath);
  const localBytes = stat.size;

  const effectiveMinBytes = Number.isFinite(minBytes)
    ? Math.max(0, minBytes)
    : 0;

  if (
    effectiveMinBytes > 0 &&
    localBytes < effectiveMinBytes
  ) {
    throw new Error(
      `ensureUploadedAndHealthy: local file too small ` +
        `(${localBytes} bytes, minimum=${effectiveMinBytes})`
    );
  }

  let exists = false;
  let remoteBytes = 0;
  let uploadedBytes: number | null = null;
  let wasReuploaded = false;

  if (!disableCache) {
    const remote = await headObjectSafe(
      client,
      bucket,
      key
    );

    exists = remote.exists;
    remoteBytes = remote.contentLength;

    if (
      exists &&
      effectiveMinBytes > 0 &&
      remoteBytes < effectiveMinBytes
    ) {
      log?.("CACHE_HIT_BUT_CORRUPT_REUPLOAD", {
        logTag,
        key,
        remoteBytes,
        localBytes,
        minBytes: effectiveMinBytes,
      });

      exists = false;
      wasReuploaded = true;
    }
  } else {
    log?.("CACHE_BYPASS", {
      logTag,
      key,
    });
  }

  if (exists) {
    log?.("CACHE_HIT", {
      logTag,
      key,
      remoteBytes,
      localBytes,
    });

    if (!disableTouch) {
      await touchMetadata({
        client,
        bucket,
        key,
      });

      log?.("TOUCH_OK", {
        logTag,
        key,
      });
    } else {
      log?.("TOUCH_SKIP", {
        logTag,
        key,
        reason: "R2_DISABLE_TOUCH=1",
      });
    }

    return {
      exists: true,
      remoteBytes,
      uploadedBytes: null,
      wasReuploaded,
    };
  }

  log?.(
    disableCache
      ? "UPLOAD_CACHE_BYPASS"
      : "CACHE_MISS_UPLOAD",
    {
      logTag,
      key,
      localBytes,
    }
  );

  uploadedBytes = await uploadWithMetadata({
    client,
    bucket,
    key,
    filePath,
    contentType,
  });

  const verification = await headObjectSafe(
    client,
    bucket,
    key
  );

  if (!verification.exists) {
    throw new Error(
      `ensureUploadedAndHealthy: uploaded object could not be verified: ${key}`
    );
  }

  remoteBytes = verification.contentLength;

  if (
    effectiveMinBytes > 0 &&
    remoteBytes < effectiveMinBytes
  ) {
    throw new Error(
      `ensureUploadedAndHealthy: uploaded object is too small ` +
        `(remote=${remoteBytes}, minimum=${effectiveMinBytes}, key=${key})`
    );
  }

  log?.("UPLOAD_OK", {
    logTag,
    key,
    uploadedBytes,
    remoteBytes,
  });

  return {
    exists: true,
    remoteBytes,
    uploadedBytes,
    wasReuploaded,
  };
}

// --------------------------------------------------
// Key builders
// --------------------------------------------------

export function buildR2MediaKey({
  kind,
  sha256,
  filename,
  prefix,
}: {
  kind: R2MediaKind;
  sha256: string;
  filename: string;
  prefix?: string;
}): string {
  const config = getR2Config();
  const finalPrefix = prefix || config.prefix;

  const safeFilename = String(
    filename || "file.bin"
  ).replace(/[^a-zA-Z0-9._-]/g, "_");

  const hash = String(sha256 || "").trim();

  if (!hash) {
    throw new Error(
      "buildR2MediaKey: sha256 is required"
    );
  }

  if (kind === "frame") {
    return `${finalPrefix}/frames/${hash}/${safeFilename}`;
  }

  if (kind === "video") {
    return `${finalPrefix}/videos/${hash}/${safeFilename}`;
  }

  return `${finalPrefix}/videos/${hash}/subclips/${safeFilename}`;
}

export async function computeHashAndKey({
  kind,
  filePath,
  filename,
  prefix,
  keyBuilder,
}: ComputeHashAndKeyInput): Promise<ComputeHashAndKeyResult> {
  const config = getR2Config();
  const finalPrefix = prefix || config.prefix;

  const sha256 = await sha256File(filePath);

  const key = keyBuilder
    ? keyBuilder({
        prefix: finalPrefix,
        sha256,
        filename,
        kind,
      })
    : buildR2MediaKey({
        kind,
        sha256,
        filename,
        prefix: finalPrefix,
      });

  if (!key || !key.trim()) {
    throw new Error(
      "computeHashAndKey: key builder returned an empty key"
    );
  }

  return {
    sha256,
    key,
  };
}

// --------------------------------------------------
// Publish and presign
// --------------------------------------------------

export async function publishAndPresign({
  kind,
  filePath,
  filename,
  contentType,
  minBytes = 0,
  keyBuilder,
  cleanupPrefixBuilder,
  cleanupPrefix,
  cleanupTtlMs,
  disableCache = false,
  disableTouch = false,
  presignExpiresIn,
  logTag = "R2",
  log,
}: PublishAndPresignInput): Promise<PublishAndPresignResult> {
  const config = getR2Config();
  const client = getR2Client();
  const bucket = config.bucket;

  const { sha256, key } = await computeHashAndKey({
    kind,
    filePath,
    filename,
    prefix: config.prefix,
    keyBuilder,
  });

  const folderPrefix =
    typeof cleanupPrefix === "string" &&
    cleanupPrefix.trim()
      ? cleanupPrefix.trim()
      : cleanupPrefixBuilder
        ? cleanupPrefixBuilder({
            prefix: config.prefix,
            sha256,
            key,
            kind,
          })
        : `${path.posix.dirname(key)}/`;

  try {
    await cleanupExpiredObjects({
      client,
      bucket,
      prefix: folderPrefix,
      ttlMs: cleanupTtlMs,

      onDelete: (deletedKey) => {
        log?.("CLEANUP_DELETE", {
          logTag,
          kind,
          key: deletedKey,
        });
      },

      onWarn: ({ key: failedKey, err }) => {
        log?.("CLEANUP_WARN", {
          logTag,
          kind,
          key: failedKey,
          err,
        });
      },
    });
  } catch (error) {
    log?.("CLEANUP_FAILED", {
      logTag,
      kind,
      msg: safeTrunc(getErrorMessage(error), 300),
    });
  }

  const finalContentType = defaultContentType({
    kind,
    filename,
    contentType,
  });

  const ensured = await ensureUploadedAndHealthy({
    key,
    filePath,
    contentType: finalContentType,
    minBytes,
    disableCache,
    disableTouch,
    logTag,
    log,
  });

  const url = await presignGet({
    client,
    bucket,
    key,
    expiresIn: presignExpiresIn,
  });

  const stat = await fs.promises.stat(filePath);

  return {
    sha256,
    key,
    url,
    bytes: stat.size,
    remoteBytes: ensured.remoteBytes,
    wasReuploaded: ensured.wasReuploaded,
  };
}