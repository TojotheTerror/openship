import {
  NginxProvider,
  detectOpenRestyPaths,
  type OpenRestyPaths,
} from "@repo/adapters";
import type { CommandExecutor } from "@repo/adapters";
import { sshManager } from "./ssh-manager";
import { cacheStore } from "./cache-store";

// 1h TTL — OpenResty path layout is effectively immutable per server,
// but cap it so a redeploy that moves nginx is caught within the hour.
const OPENRESTY_PATH_TTL_S = 60 * 60;

export async function getOpenRestyPaths(
  serverId: string,
  executor: CommandExecutor,
  forceRefresh = false,
): Promise<OpenRestyPaths> {
  const store = await cacheStore<OpenRestyPaths>("openresty-paths");
  if (!forceRefresh) {
    const cached = await store.get(serverId);
    if (cached) return cached;
  }
  const detected = await detectOpenRestyPaths(executor);
  await store.set(serverId, detected, OPENRESTY_PATH_TTL_S);
  return detected;
}

export async function invalidateOpenRestyPaths(serverId?: string): Promise<void> {
  const store = await cacheStore<OpenRestyPaths>("openresty-paths");
  if (serverId) {
    await store.delete(serverId);
    return;
  }
  await store.invalidateByPrefix("");
}

export async function withOpenRestyRouting<T>(
  serverId: string,
  fn: (routing: NginxProvider) => Promise<T>,
): Promise<T> {
  return sshManager.withExecutor(serverId, async (executor) => {
    const run = async (forceRefresh = false) => {
      const paths = await getOpenRestyPaths(serverId, executor, forceRefresh);
      const routing = new NginxProvider({ paths, executor });
      return fn(routing);
    };

    try {
      return await run(false);
    } catch (err) {
      const store = await cacheStore<OpenRestyPaths>("openresty-paths");
      if (!(await store.get(serverId))) throw err;
      await store.delete(serverId);
      return run(true);
    }
  });
}