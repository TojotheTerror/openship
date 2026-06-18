import { cloudClient } from "./cloud-client";
import { resolveServerHost } from "./server-target";

/**
 * Ensure an Oblien edge proxy exists for a managed deploy slug.
 *
 * Sends slug + target IP to the SaaS. The SaaS owns domain construction
 * and Oblien credentials. syncEdgeProxy resolves a cloud-linked member's
 * token internally — orgs need at least one connected member to use
 * cloud features, and that's surfaced via syncEdgeProxy's error.
 */
export async function ensureManagedEdgeProxy(
  organizationId: string,
  slug: string,
  opts?: { serverId?: string },
): Promise<void> {
  if (!slug.trim()) return;

  const target = await resolveServerHost(organizationId, opts?.serverId);
  if (!target) {
    throw new Error("Cannot configure edge proxy: target host could not be resolved");
  }
  const result = await cloudClient({ organizationId }).edgeProxy.sync({ slug, target });
  if (!result) {
    throw new Error(
      "Cannot sync edge proxy: no member of this organization has linked Openship Cloud",
    );
  }
}
