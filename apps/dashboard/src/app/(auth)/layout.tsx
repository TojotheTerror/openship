import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession, getDeploymentInfo } from "@/lib/server/session";
import { getCloudConnectHandoffUrl, buildAuthPageHref, DESKTOP_CLOUD_FLOW } from "@/lib/cloud-auth";
import { AuthProviders } from "./providers";

/**
 * Auth layout - minimal shell, no sidebar. Sends already-authenticated
 * users away from the login form:
 *   - With `?callback=`  → forward to the cloud-connect handoff (or
 *                          `/authorize` for the desktop flow). A blind
 *                          `redirect("/")` would silently drop the
 *                          callback and break local→cloud connect for
 *                          users with a live SaaS session.
 *   - Without `?callback=` → home.
 */
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Only redirect away from /login if the BROWSER has a real session
  // cookie. In desktop zero-auth mode the api auto-provisions a
  // session and sets the cookie on its OWN response (server-to-server
  // hop) — the browser never receives it, so server-side getSession
  // returning truthy doesn't mean the user is actually logged in here.
  // Without this gate we hit the classic redirect loop:
  //   / → proxy.ts (no cookie) → /login → layout (session truthy) →
  //   redirect("/") → /  → loop.
  const hdrs = await headers();
  const cookieHeader = hdrs.get("cookie") ?? "";
  const hasBrowserSession = /\.session_token=/.test(cookieHeader);

  const session = hasBrowserSession ? await getSession() : null;

  if (session) {
    // proxy.ts (middleware) stamps the original pathname+search onto
    // a request header — that header is set server-side AFTER the
    // middleware overrides whatever the client may have sent, so it's
    // safe to trust. Falling back to `Referer` would be client-
    // controlled and could leak a cross-origin callback into our
    // redirect chain.
    const pathWithSearch = hdrs.get("x-pathname-with-search") ?? "";
    const query = pathWithSearch.includes("?")
      ? pathWithSearch.slice(pathWithSearch.indexOf("?"))
      : "";
    const params = new URLSearchParams(query);
    const callback = params.get("callback");

    if (callback) {
      if (params.get("flow") === DESKTOP_CLOUD_FLOW) {
        redirect(buildAuthPageHref("/authorize", params));
      }
      redirect(getCloudConnectHandoffUrl(callback));
    }

    redirect("/");
  }

  const deploymentInfo = await getDeploymentInfo();

  return (
    <AuthProviders authMode={deploymentInfo.authMode} cloudAuthUrl={deploymentInfo.cloudAuthUrl} selfHosted={deploymentInfo.selfHosted}>
      <div className="th-page">{children}</div>
    </AuthProviders>
  );
}
