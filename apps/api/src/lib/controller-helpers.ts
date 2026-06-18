/**
 * Shared controller helpers - used across all Hono route handlers.
 *
 * Eliminates duplication of getUserId / param / platform() across controllers.
 */

import type { Context } from "hono";
import {
  type PlatformTarget,
  type PlatformConfig,
} from "@repo/adapters";
import { env } from "../config/env";
import { isOblienConfigured } from "./platform-mode";

// Re-export the platform accessor so existing callers that do
// `import { platform } from "@/lib/controller-helpers"` keep working
// without changing every site.
export { getPlatform as platform } from "@repo/adapters";

// ─── Auth helpers ────────────────────────────────────────────────────────────

/** Extract the authenticated user ID from Hono context */
export function getUserId(c: Context): string {
  const user = c.get("user");
  if (!user?.id) throw new Error("Unauthorized: no user in context");
  return user.id;
}

/**
 * Extract the active organization ID from Hono context. Set by
 * `authMiddleware` via `resolveActiveOrganizationId` — every authed
 * route has this populated.
 */
export function getActiveOrganizationId(c: Context): string {
  const orgId = c.get("activeOrganizationId");
  if (!orgId || typeof orgId !== "string") {
    throw new Error("No active organization in context");
  }
  return orgId;
}

/**
 * Assert a resource belongs to the caller's active organization. Throws
 * a 404-shaped error if it doesn't, to avoid leaking existence across
 * orgs (404, not 403 — IDOR-safe). NULL `organizationId` fails closed.
 */
import { NotFoundError } from "@repo/core";

export function assertResourceInOrg<T extends { organizationId?: string | null }>(
  resource: T | null | undefined,
  resourceLabel: string,
  organizationId: string,
  resourceId?: string,
): asserts resource is T {
  if (!resource || resource.organizationId !== organizationId) {
    throw new NotFoundError(resourceLabel, resourceId);
  }
}

/** Extract and validate a required route parameter */
export function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing route param: ${name}`);
  return val;
}

// ─── Platform resolution ─────────────────────────────────────────────────────

/**
 * Resolve the deployment target from environment config.
 *
 * CLOUD_MODE (SaaS hosting) and DEPLOY_MODE=cloud (Oblien runtime) both
 * need the cloud platform adapter, so either triggers the cloud config.
 * Auth/billing concerns are gated separately by CLOUD_MODE alone.
 *
 * Priority:
 *   1. CLOUD_MODE=true or DEPLOY_MODE=cloud → "cloud" (Oblien runtime)
 *   2. DEPLOY_MODE=desktop → "desktop"
 *   3. Default → "selfhosted" with docker or bare runtime
 */
export function resolvePlatformConfig(): PlatformConfig {
  if (isOblienConfigured()) {
    return {
      target: "cloud",
      cloudClientId: env.OBLIEN_CLIENT_ID,
      cloudClientSecret: env.OBLIEN_CLIENT_SECRET,
    };
  }

  if (env.DEPLOY_MODE === "desktop") {
    return { target: "desktop" };
  }

  // Self-hosted: docker or bare
  return {
    target: "selfhosted",
    runtime: env.DEPLOY_MODE === "bare" ? "bare" : "docker",
  };
}

// ─── Project access ──────────────────────────────────────────────────────────


// Access-control model:
//   - Route-level `requirePermission` middleware loads the resource and
//     verifies org membership before the controller runs.
//   - For list/create endpoints, the org is resolved from the
//     X-Organization-Id header (or the session default cookie).
//   - Service layers receive `organizationId` directly from controllers
//     and use `assertResourceInOrg(...)` for defense-in-depth.
//
// For a user-scoped access check, use `permission.assert(c, {...})` or
// `assertResourceInOrg(resource, ...)`.
