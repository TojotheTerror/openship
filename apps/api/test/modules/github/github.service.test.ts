import { beforeEach, describe, expect, it, vi } from "vitest";

const { githubFetch } = vi.hoisted(() => ({
  githubFetch: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.auth", () => ({
  githubFetch,
  getUserStatus: vi.fn(),
  getUserInstallations: vi.fn(),
  mapAccounts: vi.fn(),
  getGitHubAuthMode: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.local-auth", () => ({
  getLocalGhStatus: vi.fn(),
}));

vi.mock("../../../src/config/env", () => ({
  env: {},
  runtimeTarget: { id: "local" },
}));

import { listRepositoryTree } from "../../../src/modules/github/github.service";

function createFile(name: string, path: string) {
  return {
    name,
    path,
    sha: `${path}-sha`,
    size: 1,
    type: "file" as const,
    download_url: null,
  };
}

function createDir(name: string, path: string) {
  return {
    name,
    path,
    sha: `${path}-sha`,
    size: 0,
    type: "dir" as const,
    download_url: null,
  };
}

describe("listRepositoryTree", () => {
  beforeEach(() => {
    githubFetch.mockReset();
  });

  it("falls back to repository contents when the recursive git tree is truncated", async () => {
    githubFetch.mockImplementation(async ({ url }: { url: string }) => {
      if (url.includes("/git/trees/")) {
        return {
          sha: "tree-sha",
          truncated: true,
          tree: [{ path: "apps", mode: "040000", type: "tree", sha: "apps-sha", url: "" }],
        };
      }

      if (url.endsWith("/contents/")) {
        return [createDir("apps", "apps"), createFile("package.json", "package.json")];
      }

      if (url.endsWith("/contents/apps")) {
        return [createDir("web", "apps/web")];
      }

      if (url.endsWith("/contents/apps/web")) {
        return [createFile("package.json", "apps/web/package.json")];
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const tree = await listRepositoryTree("user-1", "openship", "repo", { branch: "main" });

    expect(tree).toEqual([
      { path: "apps", type: "dir" },
      { path: "package.json", type: "file" },
      { path: "apps/web", type: "dir" },
      { path: "apps/web/package.json", type: "file" },
    ]);
    expect(githubFetch).toHaveBeenCalledTimes(4);
  });
});