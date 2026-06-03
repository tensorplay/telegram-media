import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const INTERNAL_MEDIA_API_PATHS = new Set([
  "/api/taxonomy/category-options",
  "/api/analyze-category",
  "/api/analyze-category-preview",
  "/api/recalculate-taxonomy",
  "/api/recalculate-description",
]);

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );

          supabaseResponse = NextResponse.next({ request });

          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  const internalApiKey = process.env.MULTIPLATFORM_MEDIA_API_KEY || "";
  const requestApiKey = request.headers.get("x-api-key");

  const isInternalMediaApiPath = INTERNAL_MEDIA_API_PATHS.has(pathname);

  const isInternalMediaApiRequest =
    isInternalMediaApiPath &&
    !!internalApiKey &&
    requestApiKey === internalApiKey;

  if (isInternalMediaApiPath) {
    console.log("[telegram-medai][middleware] internal media api check", {
      pathname,
      hasUser: Boolean(user),
      isInternalMediaApiPath,
      isInternalMediaApiRequest,
      hasInternalApiKey: Boolean(internalApiKey),
      hasRequestApiKey: Boolean(requestApiKey),
      internalApiKeyPrefix: internalApiKey
        ? internalApiKey.slice(0, 6)
        : null,
      requestApiKeyPrefix: requestApiKey
        ? requestApiKey.slice(0, 6)
        : null,
    });
  }

  if (!user && pathname.startsWith("/api/") && !isInternalMediaApiRequest) {
    if (isInternalMediaApiPath) {
      console.warn("[telegram-medai][middleware] blocking api request", {
        pathname,
        reason: "missing user and invalid internal x-api-key",
        hasUser: Boolean(user),
        hasInternalApiKey: Boolean(internalApiKey),
        hasRequestApiKey: Boolean(requestApiKey),
        internalApiKeyPrefix: internalApiKey
          ? internalApiKey.slice(0, 6)
          : null,
        requestApiKeyPrefix: requestApiKey
          ? requestApiKey.slice(0, 6)
          : null,
      });
    }

    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (
    !user &&
    !isInternalMediaApiRequest &&
    !pathname.startsWith("/login") &&
    !pathname.startsWith("/auth")
  ) {
    if (isInternalMediaApiPath) {
      console.warn("[telegram-medai][middleware] redirecting request", {
        pathname,
        reason: "missing user and not internal media api request",
      });
    }

    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}