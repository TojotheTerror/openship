import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DASHBOARD_RUNTIME_TARGETS } from "@repo/core";

type Mode = "local" | "saas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const nextBin = path.join(appRoot, "node_modules", "next", "dist", "bin", "next");

function getConfig(mode: Mode) {
  const target = DASHBOARD_RUNTIME_TARGETS[mode === "saas" ? "cloud-saas" : "local"];
  return {
    port: String(target.ports.dashboard),
    distDir: mode === "saas" ? ".next-saas" : ".next",
  };
}

const mode: Mode = process.argv[2] === "saas" ? "saas" : "local";
const config = getConfig(mode);

const child = spawn("node", [nextBin, "dev", "--port", config.port], {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    OPENSHIP_TARGET: mode === "saas" ? "cloud-saas" : "local",
    NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? config.distDir,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
