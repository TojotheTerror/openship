/**
 * Openship Cloud - namespace provisioning + token minting.
 *
 * Runs on the SaaS API (CLOUD_MODE=true) only. Local instances
 * call POST /api/cloud/token to get a namespace-scoped token,
 * then use `new Oblien({ token })` to drive the full pipeline
 * themselves (workspaces.create, build, deploy - everything).
 *
 * **Namespace identity = organization id**, NOT user id. This makes
 * the namespace atomic per team: owner rotation doesn't move the
 * namespace, every team member resolves the same one, and there's
 * no `resolveCloudOwner` indirection in the SaaS controllers.
 *
 * Two responsibilities:
 *   1. ensureNamespace(orgId) - create-if-not-exists, cached
 *   2. issueNamespaceToken(orgId) - mint a scoped token for the namespace
 */

import { Oblien } from "@repo/adapters";
import { env } from "../config/env";
import { safeErrorMessage } from "@repo/core";
import { cacheStore } from "./cache-store";

// ─── Oblien client (master credentials - SaaS only) ─────────────────────────

let _client: Oblien | null = null;

export function getOblienClient(): Oblien {
  if (_client) return _client;

  // Hard gate: master Oblien credentials must only live on the SaaS
  // API process. If a self-hosted install somehow set OBLIEN_CLIENT_ID
  // (env-var typo, copied .env from cloud, etc.) and called this
  // function, the resulting client would have multi-tenant authority
  // — refuse to instantiate. CLOUD_MODE is the same flag every other
  // SaaS-only code path checks (cloud-saas.controller, namespace
  // minting), so this stays in lockstep with the rest of the boundary.
  if (!env.CLOUD_MODE) {
    throw new Error(
      "Oblien master client is only available in CLOUD_MODE — refusing to instantiate on self-hosted",
    );
  }

  const clientId = env.OBLIEN_CLIENT_ID;
  const clientSecret = env.OBLIEN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Oblien credentials not configured (OBLIEN_CLIENT_ID / OBLIEN_CLIENT_SECRET)");
  }

  _client = new Oblien({ clientId, clientSecret });
  return _client;
}

// ─── Namespace management ────────────────────────────────────────────────────

// Org ↔ namespace is effectively immutable — 1h TTL is generous and
// self-heals on miss anyway via Oblien's idempotent `namespaces.ensure`.
const NAMESPACE_CACHE_TTL_S = 60 * 60;

/**
 * Org id → namespace slug. For solo users (orgId = `org_<userId>`)
 * this strips the prefix → `os-<userId>` — keeping pre-multi-tenant
 * namespaces stable. Team orgs get `os-<orgId>` directly.
 */
function namespaceSlugForOrg(orgId: string): string {
  const stripped = orgId.startsWith("org_") ? orgId.slice(4) : orgId;
  return `os-${stripped.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}

/**
 * Ensure an Oblien namespace exists for an org. Idempotent via
 * Oblien's `namespaces.ensure`.
 */
export async function ensureNamespace(organizationId: string): Promise<string> {
  const store = await cacheStore<string>("oblien-namespaces");
  const cached = await store.get(organizationId);
  if (cached) return cached;

  const client = getOblienClient();
  const slug = namespaceSlugForOrg(organizationId);

  const ensured = await client.namespaces.ensure({
    name: `Openship ${organizationId}`,
    slug,
  });

  const namespace = ensured.data.slug || slug;
  await store.set(organizationId, namespace, NAMESPACE_CACHE_TTL_S);
  return namespace;
}

// ─── Token minting ───────────────────────────────────────────────────────────

export interface NamespaceTokenResult {
  token: string;
  namespace: string;
  expiresAt: string;
}

/**
 * Issue a namespace-scoped Oblien token for an org. The token gives
 * full access to the org's namespace — create workspaces, manage
 * lifecycle, deploy, analytics, edge proxies, pages. Local instances
 * construct `new Oblien({ token })` and run the full pipeline.
 *
 * TTL: 30 minutes (covers build + deploy + some buffer).
 */
export async function issueNamespaceToken(organizationId: string): Promise<NamespaceTokenResult> {
  const client = getOblienClient();
  const namespace = await ensureNamespace(organizationId);

  try {
    const result = await client.tokens.create({
      scope: "namespace",
      namespace,
      ttl: 1800,
    });

    return {
      token: result.token,
      namespace,
      expiresAt: result.expiresAt,
    };
  } catch (err: unknown) {
    console.error("Oblien SDK token issuance error", err);
    const message = safeErrorMessage(err);
    throw new Error(`Failed to issue Oblien namespace token for ${namespace}: ${message}`);
  }
}
