import { DASHBOARD_RUNTIME_TARGETS, DEFAULT_PORT, type DashboardRuntimeTarget } from "@repo/core";

// The runtime-target table, flattened to an array with the id inlined
// for browser-side lookup ("which row matches window.location?").
const TARGETS = Object.entries(DASHBOARD_RUNTIME_TARGETS).map(([id, t]) => ({ id, ...t }));
const DEFAULT_TARGET = TARGETS.find((t) => t.id === "local") ?? TARGETS[0]!;

type Target = (typeof TARGETS)[number];

/** Return the URL's origin (`scheme://host[:port]`), or undefined if not a valid http(s) URL. */
function originOf(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

/** Find the runtime target whose dashboard or api origin matches the URL. */
function resolveTarget(rawUrl?: string): Target {
  const origin = rawUrl ? originOf(rawUrl) : undefined;
  if (!origin) return DEFAULT_TARGET;
  return (
    TARGETS.find(
      (t) => originOf(t.dashboard) === origin || originOf(t.api) === origin,
    ) ?? DEFAULT_TARGET
  );
}

/** The target this code is currently running under — from window.location in the browser. */
function currentTarget(rawUrl?: string): Target {
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : undefined;
  return resolveTarget(rawUrl ?? browserOrigin);
}

/** The cloud-side target that the given target pairs with (per its cloudTargetId). */
function cloudPartner(target: Target): Target {
  return TARGETS.find((t) => t.id === target.cloudTargetId) ?? target;
}

// ─── Public exports ─────────────────────────────────────────────────────────

export function getRequestOriginFromHeaders(headers: Pick<Headers, "get">) {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return undefined;
  const proto =
    headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

export function getApiOrigin(rawUrl?: string) {
  return currentTarget(rawUrl).api;
}

export function getAuthBaseUrl() {
  return `${getApiOrigin()}/api/auth`;
}

export function getRestApiBaseUrl() {
  return `${getApiOrigin()}/api`;
}

export function getCloudDashboardUrl(rawUrl?: string) {
  return originOf(rawUrl ?? "") ?? cloudPartner(currentTarget()).dashboard;
}

export function getCloudApiOrigin(rawUrl?: string) {
  return originOf(rawUrl ?? "") ?? cloudPartner(currentTarget()).api;
}

/**
 * Origin of the public marketing site (apps/web), where docs and setup
 * guides live. In production: app.openship.io → openship.io. In dev:
 * localhost:3001/3002 → localhost:3000. SSR falls back to production.
 */
export function getMarketingOrigin() {
  if (typeof window === "undefined") return "https://openship.io";
  const { protocol, hostname, port } = window.location;
  if (hostname.startsWith("app.")) return `${protocol}//${hostname.slice(4)}`;
  if (port === String(DEFAULT_PORT.dashboard) || port === String(DEFAULT_PORT.saasDashboard)) {
    return `${protocol}//${hostname}:${DEFAULT_PORT.web}`;
  }
  return "https://openship.io";
}

type DeploymentInfoFallback = Pick<DashboardRuntimeTarget, "selfHosted" | "deployMode" | "authMode"> & {
  cloudAuthUrl: string;
};

export function getFallbackDeploymentInfoFromHeaders(
  headers: Pick<Headers, "get">,
): DeploymentInfoFallback {
  const target = resolveTarget(getRequestOriginFromHeaders(headers));
  return {
    selfHosted: target.selfHosted,
    deployMode: target.deployMode,
    authMode: target.authMode,
    cloudAuthUrl: cloudPartner(target).dashboard,
  };
}
