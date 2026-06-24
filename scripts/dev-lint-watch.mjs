import { spawn } from "node:child_process";
import { lstatSync, watch } from "node:fs";
import { resolve } from "node:path";

const targets = [
  "src/app",
  "src/config",
  "src/index.ts",
  "src/server.ts",
  "package.json",
  "playwright.config.ts",
  "biome.json",
];

let lintProcess = null;
let pendingRun = false;
let debounceTimer = null;
let isShuttingDown = false;

function runLint(reason) {
  if (lintProcess) {
    pendingRun = true;
    return;
  }

  console.log(`[lint-watch] Running Biome (${reason})`);

  lintProcess = spawn(process.execPath, ["run", "lint:fix"], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  lintProcess.on("exit", (code, signal) => {
    lintProcess = null;

    if (isShuttingDown) {
      return;
    }

    if (code === 0) {
      console.log("[lint-watch] Biome is up to date");
    } else {
      console.log(
        `[lint-watch] Biome exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`,
      );
    }

    if (pendingRun) {
      pendingRun = false;
      runLint("queued change");
    }
  });
}

function scheduleLint(reason) {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runLint(reason);
  }, 150);
}

const watchers = targets.map((target) => {
  const absoluteTarget = resolve(process.cwd(), target);
  const stats = lstatSync(absoluteTarget);

  return watch(
    absoluteTarget,
    stats.isDirectory() ? { recursive: true } : undefined,
    (_eventType, filename) => scheduleLint(filename ? `${target}/${filename}` : target),
  );
});

function shutdown(signal) {
  isShuttingDown = true;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  if (lintProcess) {
    lintProcess.kill(signal);
    return;
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`[lint-watch] Watching ${targets.length} targets for changes`);
runLint("startup");
