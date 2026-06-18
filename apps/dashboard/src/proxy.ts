import { NextRequest, NextResponse } from "next/server";

// Cookie presence only — never proof of a valid session. Server-side
// `getSession()` in (dashboard) layout is the real authoritative
// check; this middleware just short-circuits the obviously-unauthed
// case to skip the layout fetch.

const PUBLIC_ROUTES = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/authorize",
  "/onboarding",
];

const SESSION_COOKIE_SUFFIX = ".session_token";

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const hasCookie = req.cookies.getAll().some((c) => c.name.endsWith(SESSION_COOKIE_SUFFIX));

  if (!hasCookie && !isPublic) {
    const url = new URL("/login", req.url);
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  // Stamp the pathname+search onto a request header so server layouts
  // can read query params (layouts don't receive `searchParams` in App
  // Router). (auth)/layout.tsx uses this to honor a `callback=` on
  // /login when the user already has a SaaS session.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname-with-search", `${pathname}${search}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
