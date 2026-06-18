import type { Context, Next } from "hono";
import { auth } from "../lib/auth";
import { ensureLocalUser } from "../lib/local-user";
import { resolveActiveOrganizationId } from "./active-organization";
import { getAuthMode } from "../lib/auth-mode";

/**
 * Hosts that are treated as loopback for the zero-auth fallback. Any
 * other Host header forces a 401 even when authMode === "none", so an
 * operator who accidentally exposes a zero-auth instance to a public
 * interface does not silently hand out admin access.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackHost(rawHost: string | undefined): boolean {
  if (!rawHost) return false;
  // Strip port. IPv6 hosts arrive bracketed (`[::1]:3000`), IPv4/hostnames as `host:port`.
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith("[")) {
    const closing = host.indexOf("]");
    if (closing !== -1) host = host.slice(0, closing + 1);
  } else {
    const colon = host.indexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Session authentication middleware.
 *
 * Unified flow across every deploy mode:
 *   1. Try the real Better Auth session. If present, stamp the request and continue.
 *   2. No session → consult `getAuthMode()`.
 *   3. authMode !== "none" → 401.
 *   4. authMode === "none" → loopback guardrail. Only allow the
 *      auto-provisioned local admin when the Host header is loopback;
 *      otherwise log and 401 so a zero-auth box exposed to the public
 *      internet does not hand out admin access.
 *
 * Active-org resolution is delegated to `resolveActiveOrganizationId` —
 * the single source of truth that prefers team orgs over empty personal
 * workspaces (see middleware/active-organization.ts).
 *
 * Supports both cookie-based sessions (dashboard) and Bearer tokens (CLI/API).
 */
export async function authMiddleware(c: Context, next: Next) {
  // 1. Real session takes precedence in every mode.
  try {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
    if (session) {
      await applyAuthedRequest(
        c,
        session.user,
        session.session as { activeOrganizationId?: string | null },
      );
      return next();
    }
  } catch {
    // No valid session — fall through to the zero-auth check below.
  }

  // 2. No session: gate everything on the operator-controlled authMode.
  const authMode = await getAuthMode();
  if (authMode !== "none") {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // 3. Zero-auth path. Refuse anything that isn't a loopback Host so a
  //    box exposed to the public internet cannot accidentally serve the
  //    auto-provisioned admin.
  const host = c.req.header("host");
  if (!isLoopbackHost(host)) {
    console.warn(`[auth] zero-auth refused for non-loopback host=${host ?? "<missing>"}`);
    return c.json({ error: "Unauthorized" }, 401);
  }

  const user = await ensureLocalUser();
  await applyAuthedRequest(c, user, null);
  c.set("session", { id: "zero-auth", userId: user.id });
  return next();
}

/**
 * Stamp the request with user + session + resolved active org. Shared
 * by every successful auth path so the smart-default org resolution
 * runs in exactly one place.
 */
async function applyAuthedRequest(
  c: Context,
  user: { id: string },
  session: { activeOrganizationId?: string | null } | null,
): Promise<void> {
  c.set("user", user);
  if (session) c.set("session", session);
  const orgId = await resolveActiveOrganizationId(
    user.id,
    session?.activeOrganizationId ?? null,
  );
  if (orgId) c.set("activeOrganizationId", orgId);
}
