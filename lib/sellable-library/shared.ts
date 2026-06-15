// telegram-media/lib/sellable-library/shared.ts
import { NextRequest } from "next/server";

export function isInternalMediaApiRequest(request: NextRequest) {
  const internalApiKey = process.env.MEDIA_KEY || "";
  const requestApiKey = request.headers.get("x-api-key");

  return !!internalApiKey && requestApiKey === internalApiKey;
}

export function getOfBackendConfig() {
  const url = process.env.BACKEND_URL || "";
  const apiKey = process.env.BACKEND_KEY || "";

  if (!url) {
    throw new Error("Missing BACKEND_URL");
  }

  if (!apiKey) {
    throw new Error("Missing BACKEND_KEY");
  }

  return {
    url: url.replace(/\/$/, ""),
    apiKey,
  };
}

export function normalizeString(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizePositiveInt(
  value: unknown,
  fallback: number,
  max: number
) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(max, parsed));
}

export function normalizeBoolean(value: unknown, fallback: boolean) {
  if (value === true) return true;
  if (value === false) return false;

  return fallback;
}

export function normalizeArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export async function postBackend(path: string, body: any) {
  const backend = getOfBackendConfig();

  const res = await fetch(`${backend.url}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": backend.apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  let json: any = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `Backend request failed: ${res.status} ${path} ${JSON.stringify(json).slice(0, 1000)}`
    );
  }

  return json;
}