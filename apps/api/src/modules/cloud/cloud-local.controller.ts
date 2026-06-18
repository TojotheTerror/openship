/**
 * Cloud local controller - runs only when !CLOUD_MODE.
 *
 * Dynamic imports for security isolation: cloud-client and cloud-auth-proxy
 * are never loaded on the SaaS. This prevents self-hosted code paths
 * (which handle user credentials, SSH config, etc.) from being accessible
 * in the SaaS process.
 *
 *   POST /api/cloud/disconnect      - clear stored session
 *   GET  /api/cloud/status          - check connection state
 *   GET  /api/cloud/connect-callback - exchange code from external auth
 */

import type { Context } from "hono";
import { Oblien } from "@repo/adapters";
import { repos } from "@repo/db";
import { getUserId, getActiveOrganizationId } from "../../lib/controller-helpers";
import { audit, auditContextFrom } from "../../lib/audit";
import {
  cloudClient,
  getCloudConnectionStatus,
} from "../../lib/cloud-client";
import { safeErrorMessage } from "@repo/core";

// ─── Result page (shown in popup / browser tab after connect) ────────────────

function connectResultPage(title: string, message: string, success = false): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Openship</title>
<script>
// Auto-close popup windows; the opener detects the close event.
if (window.opener) { window.close(); }
</script></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#fafafa">
<div style="text-align:center;max-width:420px">
  <div style="font-size:48px;margin-bottom:16px">${success ? "\u2713" : "\u26A0"}</div>
  <h2 style="margin:0 0 8px">${title}</h2>
  <p style="color:#888;margin:0 0 24px">${message}</p>
  ${success ? '<p style="color:#555;font-size:14px">You can close this window.</p>' : ""}
</div>
</body></html>`;
}

// ─── Cloud workspaces / drift ────────────────────────────────────────────────

/**
 * GET /api/cloud/workspaces
 *
 * The recovery + drift primitive. Lists every workspace in the
 * active organization's owner namespace on Oblien, joins against
 * local `project.cloud_workspace_id` for the active org, returns:
 *
 *   - workspaces[]      every workspace owned by the org on cloud,
 *                       annotated with the local project (if any)
 *                       it's bound to
 *   - orphanedCloud[]   workspaces with no matching local project —
 *                       these surface in the Import wizard
 *   - orphanedLocal[]   local projects whose cloud_workspace_id is
 *                       no longer on cloud (deleted from Oblien
 *                       directly, or never existed) — surface as a
 *                       red badge with "Re-deploy" / "Delete local"
 *
 * Runs entirely on the local API. SaaS is touched only to mint the
 * namespace token through the org-owner cloud link (whichever member
 * of the org linked cloud). This means every member of the org sees
 * the same workspace list, and `connected: false` is returned only
 * when NO member of the org has linked cloud — not when the calling
 * user personally hasn't linked.
 *
 * Oblien enforces namespace isolation natively, so the listing
 * returned here is exactly the set of workspaces the org is allowed
 * to see.
 */
export async function listWorkspaces(c: Context) {
  const organizationId = getActiveOrganizationId(c);

  const tokenResult = await cloudClient({ organizationId })
    .token()
    .catch(() => null);
  if (!tokenResult) {
    return c.json({
      connected: false,
      workspaces: [],
      orphanedCloud: [],
      orphanedLocal: [],
    });
  }

  let cloudWorkspaces: Array<{
    id: string;
    slug?: string | null;
    name?: string;
    status: string;
    namespace?: string;
    createdAt: string;
    updatedAt: string;
  }>;
  try {
    const oblien = new Oblien({ token: tokenResult.token });
    const result = await oblien.workspaces.list({ limit: 200 });
    cloudWorkspaces = (result.workspaces as Array<{
      id: string;
      slug?: string | null;
      name?: string;
      status: string;
      namespace?: string;
      created_at: string;
      updated_at: string;
    }>).map((w) => ({
      id: w.id,
      slug: w.slug ?? null,
      name: w.name,
      status: w.status,
      namespace: w.namespace,
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    }));
  } catch (err) {
    console.error(
      `[cloud-workspaces] Oblien list failed: ${safeErrorMessage(err)}`,
    );
    return c.json(
      {
        connected: true,
        error: "Could not list workspaces from Openship Cloud",
        workspaces: [],
        orphanedCloud: [],
        orphanedLocal: [],
      },
      502,
    );
  }

  // Pull local projects targeting cloud for this org.
  const localProjects = await repos.project
    .listCloudProjectsByOrganization(organizationId)
    .catch(() => [] as Array<{ id: string; name: string; slug: string; cloudWorkspaceId: string | null }>);

  const localByWorkspace = new Map<string, typeof localProjects[number]>();
  for (const p of localProjects) {
    if (p.cloudWorkspaceId) localByWorkspace.set(p.cloudWorkspaceId, p);
  }
  const cloudWorkspaceIds = new Set(cloudWorkspaces.map((w) => w.id));

  const workspaces = cloudWorkspaces.map((w) => ({
    ...w,
    localProject: localByWorkspace.get(w.id)
      ? {
          id: localByWorkspace.get(w.id)!.id,
          name: localByWorkspace.get(w.id)!.name,
          slug: localByWorkspace.get(w.id)!.slug,
        }
      : null,
  }));

  const orphanedCloud = cloudWorkspaces.filter((w) => !localByWorkspace.has(w.id));

  const orphanedLocal = localProjects.filter(
    (p) => p.cloudWorkspaceId && !cloudWorkspaceIds.has(p.cloudWorkspaceId),
  );

  return c.json({
    connected: true,
    namespace: tokenResult.namespace,
    workspaces,
    orphanedCloud,
    orphanedLocal,
  });
}

// ─── Cloud account management ────────────────────────────────────────────────

export async function disconnect(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  await cloudClient({ userId }).disconnect();
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "cloud.disconnect",
    resourceType: "cloud",
    resourceId: "*",
  });
  return c.json({ connected: false });
}

export async function status(c: Context) {
  const userId = getUserId(c);
  return c.json(await getCloudConnectionStatus(userId));
}

/**
 * GET /api/cloud/connect-callback?code=<one-time-code>
 *
 * After the user authenticates on Openship Cloud, they're redirected
 * here with a one-time code. We exchange it and store the cloud token.
 */
export async function connectCallback(c: Context) {
  const userId = getUserId(c);
  const code = c.req.query("code");
  if (!code) {
    console.error("[cloud-connect-callback] missing code query param");
    return c.html(
      connectResultPage(
        "Missing Code",
        "The authentication code was not provided. Please try again.",
      ),
    );
  }

  try {
    const { exchangeCodeWithCloud, storeCloudSession } = await import(
      "../../lib/cloud-auth-proxy"
    );

    const data = await exchangeCodeWithCloud(code);
    if (!data) {
      // exchangeCodeWithCloud already logged the specific failure
      // reason (network / non-2xx / non-JSON / parse error). Operator
      // sees the line in the API log.
      return c.html(
        connectResultPage(
          "Connection Failed",
          "Could not verify with Openship Cloud — check the API log for the exact reason (network, cloud unreachable, or invalid response).",
        ),
      );
    }

    await storeCloudSession(userId, data.sessionToken);

    return c.html(
      connectResultPage(
        "Connected to Openship Cloud",
        "Your instance is now linked. You can close this window.",
        true,
      ),
    );
  } catch (err) {
    console.error(
      `[cloud-connect-callback] unexpected error: ${safeErrorMessage(err)
      }`,
    );
    return c.html(
      connectResultPage(
        "Connection Failed",
        `Something went wrong: ${safeErrorMessage(err)
        }`,
      ),
    );
  }
}
