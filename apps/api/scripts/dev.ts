import { spawn, execSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORT,
  DASHBOARD_RUNTIME_TARGETS,
  type DashboardRuntimeTargetId,
} from "@repo/core";

type Mode = "local" | "saas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

function getConfig(mode: Mode) {
  const target: DashboardRuntimeTargetId = mode === "saas" ? "cloud-saas" : "local";
  const port =
    target === "local"
      ? DEFAULT_PORT.api
      : DEFAULT_PORT.saasApi;

  const baseEnv = {
    NODE_ENV: "development",
    OPENSHIP_TARGET: target,
    CLOUD_MODE: mode === "saas" ? "true" : "false",
    DEPLOY_MODE: mode === "saas" ? "cloud" : "desktop",
  };

  if (mode === "saas") {
    return {
      port,
      envFile: ".env.saas",
      env: {
        ...baseEnv,
        PGLITE_DATA_DIR:
          process.env.PGLITE_DATA_DIR ??
          path.join(homedir(), ".openship", "data-saas"),
      },
    };
  }

  return { port, envFile: ".env", env: baseEnv };
}

/**
 * Free the port before spawning. Hot-reload's old child may still be
 * holding the listener for a few ms after SIGTERM — we kill anything
 * bound to OUR target port so the new child can bind cleanly. macOS
 * (lsof) and linux both support this; on windows just skip.
 */
function freePort(port: number): void {
  if (process.platform === "win32") return;
  try {
    const pids = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`, {
      encoding: "utf-8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (pids.length === 0) return;
    console.log(`[dev] freeing port ${port} (killing ${pids.join(", ")})`);
    execSync(`kill -9 ${pids.join(" ")} 2>/dev/null || true`);
  } catch {
    // best-effort
  }
}

const mode: Mode = process.argv[2] === "saas" ? "saas" : "local";
const config = getConfig(mode);

// Verify the table also resolved to the same port. Cheap sanity check
// that catches schema drift (table edited but DEFAULT_PORT not).
const resolved = DASHBOARD_RUNTIME_TARGETS[mode === "saas" ? "cloud-saas" : "local"];
if (resolved.ports.api !== config.port) {
  throw new Error(
    `dev script port mismatch: DEFAULT_PORT=${config.port}, table=${resolved.ports.api}`,
  );
}

freePort(config.port);

const child = spawn(
  "node",
  ["--env-file", config.envFile, "--import", "tsx", "--watch", "src/index.ts"],
  {
    cwd: appRoot,
    stdio: "inherit",
    env: { ...process.env, ...config.env },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

// On Ctrl-C / kill, free the port AGAIN so a follow-up `bun dev` boots
// cleanly. Without this, the child may still be in TIME_WAIT.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      // ignore
    }
    setTimeout(() => {
      freePort(config.port);
      process.exit(0);
    }, 200);
  });
}
