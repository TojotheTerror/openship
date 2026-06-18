/**
 * Cloud client - used by local/self-hosted instances to get
 * an Oblien namespace token from api.openship.io.
 *
 * Auth is fully server-side: the user's Openship Cloud session
 * is stored (encrypted) in user_settings.cloud_session_token.
 * This module reads it from DB, fetches namespace tokens from
 * the SaaS API, and caches them in memory.
 *
 * No client-side cookies or tokens involved.
 */

import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import type { CloudPreflightData } from "./cloud-preflight";
import { cloudRuntimeTarget, cloudRuntimeTargetId } from "../config/env";
import { decrypt } from "./encryption";
import { cacheStore, type CacheStore } from "./cache-store";

export interface CloudAccount {
  name: string;
  email: string;
  image?: string | null;
}

// Shared CacheStore namespaces. cacheStore is idempotent per
// namespace — same name always returns the same store. Redis when
// reachable, memory fallback otherwise. Refresh tokens 5 min before
// Oblien's 30-min TTL so a cached value is always still valid.

interface TokenCache {
  token: string;
  namespace: string;
}

const TOKEN_TTL_S = 25 * 60;
const STATUS_TTL_S = 5 * 60;

// ─── Authenticated cloud fetch (INTERNAL primitives) ─────────────────────────

/**
 * Make an authenticated request to the SaaS API using the stored cloud session.
 *
 * Handles: read session → decrypt → Bearer auth → 401 session cleanup.
 * Returns the Response, or null if not connected.
 */
export async function cloudFetch(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const settings = await repos.settings.findByUser(userId);
  if (!settings?.cloudSessionToken) return null;

  const sessionToken = decrypt(settings.cloudSessionToken);

  const targetUrl = `${cloudRuntimeTarget.api}${path}`;
  console.log(`[cloud-client] → ${targetUrl}  (cloudRuntimeTargetId=${cloudRuntimeTargetId})`);
  let res: Response;
  try {
    res = await fetch(targetUrl, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
        Authorization: `Bearer ${sessionToken}`,
      },
    });
  } catch (err) {
    console.warn(`[cloud-client] fetch failed ${targetUrl}: ${(err as Error).message}`);
    return null;
  }

  if (res.status === 401) {
    await repos.settings.update(userId, { cloudSessionToken: null });
    const tokens = await cacheStore<TokenCache>("oblien-ns-tokens");
    await tokens.delete(userId);
  }

  return res;
}

/**
 * Org-bearing variant of cloudFetch. Resolves the org owner's cloud
 * session token via findOrgOwnerCloudLink, then makes the call as
 * that user. Every org-scoped cloud bridge function uses this — the
 * pattern is "any member of the org gets to act with the owner's
 * SaaS identity for org-scoped operations".
 *
 * Returns null when no member of the org has linked Openship Cloud.
 */
async function cloudFetchAsOrgOwner(
  organizationId: string,
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const linked = await repos.settings
    .findOrgOwnerCloudLink(organizationId)
    .catch(() => undefined);
  if (!linked) return null;
  return cloudFetch(linked.userId, path, init);
}

/**
 * Defensive JSON parser for cloud responses. Cloud endpoints SHOULD
 * return application/json — but a dev server may serve a 200 HTML
 * error page, or a proxy may return a captive-portal page, etc.
 * `.json()` on that body throws "Unexpected token '<'" and crashes
 * the calling handler.
 *
 * Use this for every cloud-client read: returns the parsed JSON when
 * the body is real JSON, otherwise null (caller treats as unreachable).
 */
async function readCloudJson<T>(res: Response): Promise<T | null> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ─── GitHub App proxy types (cloud holds the App private key) ───────────────
//
// Self-hosted instances never hold GITHUB_APP_ID / GITHUB_PRIVATE_KEY.
// All App-scoped operations (install URL, list installations, mint install
// tokens, OAuth identity) are proxied through api.openship.io which is the
// sole holder of the App credentials. The local instance authenticates with
// its cloud_session_token (same as every other cloud-proxied feature).
//
// What stays local on self-hosted:
//   - per-project / per-user clone tokens (PATs) — full escape hatch
//   - gh CLI fallback for offline / CI installs
//   - the resolved access tokens minted by cloud (cached briefly in memory)
//
// What lives in the cloud:
//   - the GitHub App identity, private key, webhook secret
//   - the OAuth client_id/secret + user identity (login, avatar)
//   - the canonical list of installations per cloud user
//   - the JWT signer + access_token mint endpoint

export interface CloudGithubInstallation {
  id: number;
  login: string;
  avatarUrl: string;
  type: "User" | "Organization";
}

export interface CloudGithubInstallationToken {
  token: string;
  /** ISO 8601 timestamp - GitHub install tokens expire in 60min. */
  expiresAt: string;
}

export interface CloudGithubUserStatus {
  connected: boolean;
  login?: string;
  avatarUrl?: string;
  id?: number;
}

// ─── Unified cloud client ────────────────────────────────────────────────────
//
// The single public surface for talking to the SaaS. Construction takes the
// scope (userId or organizationId) once; every method below dispatches to the
// right internal primitive (cloudFetch vs cloudFetchAsOrgOwner) based on that
// scope.
//
// The standalone exports below this section are thin delegations kept around
// so callers can migrate at their own pace.

export type CloudClientScope = { userId: string } | { organizationId: string };

export interface CloudClient {
  github: {
    installUrl(): Promise<{ url: string; state: string } | null>;
    oauthHandoff(): Promise<{ url: string } | null>;
    userStatus(): Promise<CloudGithubUserStatus | null>;
    installations(): Promise<CloudGithubInstallation[] | null>;
    installationToken(
      owner: string,
      repos?: string[],
    ): Promise<{ token: string; expiresAt: string } | null>;
  };
  pages: {
    create(input: {
      workspace_id: string;
      path: string;
      name: string;
      slug: string;
      domain?: string;
    }): Promise<{ page: { slug: string; url?: string | null } }>;
  };
  edgeProxy: {
    sync(input: {
      slug: string;
      target: string;
    }): Promise<{ ok: true; hostname: string } | null>;
  };
  analytics: {
    timeseries<T>(domain: string, params?: Record<string, unknown>): Promise<T | null>;
    requests<T>(domain: string, params?: Record<string, unknown>): Promise<T | null>;
    streamToken<T>(domain: string, params?: Record<string, unknown>): Promise<T | null>;
  };
  preflight(input: {
    slug?: string;
    customDomain?: string;
  }): Promise<CloudPreflightData | null>;
  account(): Promise<CloudAccount | null>;
  disconnect(): Promise<void>;
  token(): Promise<{ token: string; namespace: string } | null>;
}

/**
 * Build a unified cloud client bound to a single identity. All methods on the
 * returned client dispatch through the appropriate authenticated primitive:
 *
 *   cloudClient({ userId })          → cloudFetch(userId, …)
 *   cloudClient({ organizationId })  → cloudFetchAsOrgOwner(orgId, …)
 *
 * Methods that look up cached state (token, account) key their cache off the
 * resolved cloud user id — for org scope, that's the org owner.
 */
export function cloudClient(scope: CloudClientScope): CloudClient {
  const isUserScope = "userId" in scope;

  /** Authenticated SaaS fetch using the bound scope. */
  const fetchScoped = (path: string, init?: RequestInit) =>
    isUserScope
      ? cloudFetch(scope.userId, path, init)
      : cloudFetchAsOrgOwner(scope.organizationId, path, init);

  /** Resolve the underlying cloud-linked user id for cache keys. Returns
   *  null when org scope is used and no member has linked Openship Cloud. */
  const resolveUserId = async (): Promise<string | null> => {
    if (isUserScope) return scope.userId;
    const linked = await repos.settings
      .findOrgOwnerCloudLink(scope.organizationId)
      .catch(() => undefined);
    return linked?.userId ?? null;
  };

  return {
    github: {
      async installUrl() {
        const res = await fetchScoped("/api/cloud/github/install-url", {
          method: "POST",
        });
        if (!res || !res.ok) return null;
        const json = await readCloudJson<{ data: { url: string; state: string } }>(res);
        return json?.data ?? null;
      },
      async oauthHandoff() {
        const res = await fetchScoped("/api/cloud/github/oauth-handoff", {
          method: "POST",
        });
        if (!res || !res.ok) return null;
        const json = await readCloudJson<{ data: { url: string } }>(res);
        return json?.data ?? null;
      },
      async userStatus() {
        const res = await fetchScoped("/api/cloud/github/user-status", {
          method: "GET",
        });
        if (!res || !res.ok) return null;
        const json = await readCloudJson<{ data: CloudGithubUserStatus }>(res);
        return json?.data ?? null;
      },
      async installations() {
        const res = await fetchScoped("/api/cloud/github/installations", {
          method: "GET",
        });
        if (!res || !res.ok) return null;
        const json = await readCloudJson<{ data: CloudGithubInstallation[] }>(res);
        return json?.data ?? null;
      },
      async installationToken(owner, repos) {
        const res = await fetchScoped("/api/cloud/github/installation-token", {
          method: "POST",
          body: JSON.stringify({ owner, repos }),
        });
        if (!res || !res.ok) return null;
        const json = await readCloudJson<{ data: CloudGithubInstallationToken }>(res);
        return json?.data ?? null;
      },
    },

    pages: {
      async create(input) {
        const res = await fetchScoped("/api/cloud/pages", {
          method: "POST",
          body: JSON.stringify(input),
        });
        if (!res) {
          throw new Error(
            "Not connected to Openship Cloud — connect your account in Settings.",
          );
        }
        if (!res.ok) {
          let detail = `Cloud page creation failed: HTTP ${res.status}`;
          const body = await readCloudJson<{ error?: string }>(res);
          if (body?.error) detail = body.error;
          throw new Error(detail);
        }
        const body = await readCloudJson<{ page: { slug: string; url?: string | null } }>(res);
        if (!body) {
          throw new Error(
            "Cloud returned a non-JSON response when creating the page.",
          );
        }
        return body;
      },
    },

    edgeProxy: {
      async sync(input) {
        const res = await fetchScoped("/api/cloud/edge-proxy", {
          method: "POST",
          body: JSON.stringify(input),
        });
        if (!res) return null;
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Edge proxy sync failed (${res.status}): ${text}`);
        }
        const body = await readCloudJson<{ ok: true; hostname: string }>(res);
        return body ?? null;
      },
    },

    analytics: {
      async timeseries<T>(domain: string, params?: Record<string, unknown>) {
        const res = await fetchScoped("/api/cloud/analytics", {
          method: "POST",
          body: JSON.stringify({ operation: "timeseries", domain, params }),
        });
        if (!res?.ok) return null;
        return readCloudJson<T>(res);
      },
      async requests<T>(domain: string, params?: Record<string, unknown>) {
        const res = await fetchScoped("/api/cloud/analytics", {
          method: "POST",
          body: JSON.stringify({ operation: "requests", domain, params }),
        });
        if (!res?.ok) return null;
        return readCloudJson<T>(res);
      },
      async streamToken<T>(domain: string, params?: Record<string, unknown>) {
        const res = await fetchScoped("/api/cloud/analytics", {
          method: "POST",
          body: JSON.stringify({ operation: "streamToken", domain, params }),
        });
        if (!res?.ok) return null;
        return readCloudJson<T>(res);
      },
    },

    async preflight(input) {
      const res = await fetchScoped("/api/cloud/preflight", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!res || !res.ok) return null;
      const json = await readCloudJson<{ data: CloudPreflightData }>(res);
      return json?.data ?? null;
    },

    async account() {
      const res = await fetchScoped("/api/cloud/account", { method: "GET" });
      if (!res || !res.ok) return null;
      const json = await readCloudJson<{ user?: CloudAccount }>(res);
      return json?.user ?? null;
    },

    async disconnect() {
      // Only meaningful at user scope — there is no "org-level" SaaS session
      // to revoke. For org scope we resolve the linked owner and disconnect
      // them; this mirrors the org→owner pattern used elsewhere.
      const userId = await resolveUserId();
      if (!userId) return;
      try {
        const res = await cloudFetch(userId, "/api/cloud/disconnect", {
          method: "POST",
        });
        if (res && !res.ok) {
          console.warn(
            `[cloud disconnect] SaaS returned ${res.status} on session revoke; clearing local anyway`,
          );
        }
      } catch (err) {
        console.warn(
          `[cloud disconnect] SaaS revoke failed (clearing local anyway):`,
          safeErrorMessage(err),
        );
      }
      await repos.settings.update(userId, { cloudSessionToken: null });
      const [tokens, statuses] = await Promise.all([
        cacheStore<TokenCache>("oblien-ns-tokens"),
        cacheStore<CloudAccount>("cloud-status"),
      ]);
      await Promise.all([tokens.delete(userId), statuses.delete(userId)]);
    },

    async token() {
      const userId = await resolveUserId();
      if (!userId) return null;
      const store = await cacheStore<TokenCache>("oblien-ns-tokens");
      const cached = await store.get(userId);
      if (cached) return cached;

      const res = await cloudFetch(userId, "/api/cloud/token", { method: "POST" });
      if (!res || !res.ok) return null;

      const json = await readCloudJson<{
        data: { token: string; namespace: string; expiresAt: string };
      }>(res);
      if (!json?.data) return null;

      const entry: TokenCache = { token: json.data.token, namespace: json.data.namespace };
      await store.set(userId, entry, TOKEN_TTL_S);
      return entry;
    },
  };
}

// ─── Cloud session management ────────────────────────────────────────────────

/**
 * Check whether the user has a stored cloud session.
 */
export async function isCloudConnected(userId: string): Promise<boolean> {
  const settings = await repos.settings.findByUser(userId);
  return !!settings?.cloudSessionToken;
}

export async function invalidateCloudStatusCache(userId: string): Promise<void> {
  const store = await cacheStore<CloudAccount>("cloud-status");
  await store.delete(userId);
}

/**
 * Resolve cloud connection state for the local user. The presence of
 * `cloudSessionToken` in user_settings IS the connection — no SaaS
 * round-trip needed to verify it. The /account fetch ONLY runs to
 * surface profile data (name/email/avatar); result cached for 5min
 * via the shared CacheStore. A 401 on the cached call drops the
 * cache and marks disconnected lazily.
 */
export async function getCloudConnectionStatus(
  userId: string,
): Promise<{ connected: boolean; user?: CloudAccount }> {
  const settings = await repos.settings.findByUser(userId);
  const store = await cacheStore<CloudAccount>("cloud-status");
  if (!settings?.cloudSessionToken) {
    await store.delete(userId);
    return { connected: false };
  }

  const cached = await store.get(userId);
  if (cached) {
    return { connected: true, user: cached };
  }

  const res = await cloudFetch(userId, "/api/cloud/account", { method: "GET" });
  if (res?.status === 401) {
    await store.delete(userId);
    return { connected: false };
  }

  const user = res?.ok
    ? (await readCloudJson<{ user?: CloudAccount }>(res))?.user
    : undefined;
  // Only cache positive responses. The OLD code had no cache; caching a
  // null/undefined user here would be indistinguishable from a cache miss
  // on subsequent reads (store.get returns null in both cases), so we skip
  // the write when there's nothing meaningful to cache.
  if (user) {
    await store.set(userId, user, STATUS_TTL_S);
  }
  return { connected: true, ...(user ? { user } : {}) };
}

// ─── Namespace token fetching ────────────────────────────────────────────────

/**
 * Org-scoped cloud-token lookup. Returns the owner's cloud token —
 * only the owner can link Openship Cloud, and their connection is the
 * org's cloud identity for every member to use under the hood.
 */
export async function getOrgCloudToken(
  organizationId: string,
): Promise<{ token: string; namespace: string; userId: string } | null> {
  const settings = await repos.settings
    .findOrgOwnerCloudLink(organizationId)
    .catch(() => undefined);
  if (!settings) return null;
  const token = await cloudClient({ userId: settings.userId }).token();
  if (!token) return null;
  return { ...token, userId: settings.userId };
}

