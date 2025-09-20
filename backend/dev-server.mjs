#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const projectDir = resolve(process.cwd());
const distEntry = resolve(projectDir, "dist/main.js");
const tscBin = resolve(projectDir, "node_modules/typescript/bin/tsc");

let appProcess = null;
let buildReady = false;
let restartPending = false;

const tscProcess = spawn(process.execPath, [tscBin, "--watch", "--preserveWatchOutput"], {
  cwd: projectDir,
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "development",
  },
});

const successPattern = /Found 0 errors?\. Watching for file changes\./;
const failurePattern = /Found \d+ errors?\. Watching for file changes\./;

function startApp() {
  if (appProcess) {
    return;
  }
  appProcess = spawn(process.execPath, [distEntry], {
    cwd: projectDir,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "development",
    },
  });

  appProcess.on("exit", (code, signal) => {
    const expected = restartPending && signal === "SIGTERM";
    appProcess = null;
    if (expected) {
      restartPending = false;
      startApp();
      return;
    }
    if (typeof code === "number" && code !== 0) {
      process.stderr.write(`Application exited with code ${code}\n`);
    }
    shutdown(typeof code === "number" ? code : 0);
  });
}

function restartApp() {
  if (!appProcess) {
    startApp();
    return;
  }
  restartPending = true;
  appProcess.kill("SIGTERM");
}

function shutdown(code = 0) {
  if (appProcess) {
    appProcess.kill("SIGTERM");
    appProcess = null;
  }
  if (tscProcess) {
    tscProcess.kill("SIGTERM");
  }
  process.exit(code);
}

let stdoutBuffer = "";
let stderrBuffer = "";

function handleOutput(chunk, isError = false) {
  const buffer = isError ? (stderrBuffer += chunk.toString()) : (stdoutBuffer += chunk.toString());
  const lines = buffer.split(/\r?\n/);
  const pending = lines.pop();
  lines.forEach((line) => {
    if (!line.trim()) return;
    process[isError ? "stderr" : "stdout"].write(`[tsc] ${line}\n`);
    if (!isError) {
      if (successPattern.test(line)) {
        if (!buildReady) {
          buildReady = true;
          startApp();
        } else {
          restartApp();
        }
      } else if (failurePattern.test(line)) {
        process.stderr.write("[dev] Build failed; waiting for changes...\n");
      }
    }
  });
  if (isError) {
    stderrBuffer = pending ?? "";
  } else {
    stdoutBuffer = pending ?? "";
  }
}

tscProcess.stdout.on("data", (chunk) => handleOutput(chunk, false));
tscProcess.stderr.on("data", (chunk) => handleOutput(chunk, true));

tscProcess.on("exit", (code) => {
  process.stderr.write(`[dev] TypeScript watcher exited with code ${code}\n`);
  shutdown(typeof code === "number" ? code : 1);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
