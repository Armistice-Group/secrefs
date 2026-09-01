#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import spawn from "cross-spawn";
import { SecRefs, SecRefsResolutionError } from "../src/index.js";
import { parseEnvFileText } from "../src/envFile.js";

const CLI_VERSION = "0.1.0";

interface CommonOptions {
  envFile: string | false;
}

function loadEnvFile(opts: CommonOptions): void {
  if (opts.envFile === false) return;
  const envFilePath = path.resolve(process.cwd(), opts.envFile);
  if (!existsSync(envFilePath)) return;

  let rawText: string;
  try {
    rawText = readFileSync(envFilePath, "utf8");
  } catch (err) {
    console.error(
      `secrefs: failed to read ${envFilePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    throw err;
  }

  let parsed: Record<string, string>;
  try {
    parsed = parseEnvFileText(rawText);
  } catch (err) {
    console.error(
      `secrefs: failed to parse ${envFilePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    throw err;
  }

  // Mirror dotenv.config()'s default precedence: never override a value
  // already present in process.env (e.g. set explicitly by the shell/CI).
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function runCommand(commandArgs: string[], opts: CommonOptions): Promise<void> {
  if (commandArgs.length === 0) {
    console.error("secrefs run: no command given. Usage: secrefs run -- <command> [args...]");
    process.exitCode = 1;
    return;
  }

  try {
    loadEnvFile(opts);
  } catch {
    return;
  }

  const instance = new SecRefs();
  try {
    const changedKeys = await instance.init();
    if (changedKeys.length > 0) {
      console.error(
        `secrefs: resolved ${changedKeys.length} secret reference(s): ${changedKeys.join(", ")}`,
      );
    }
  } catch (err) {
    if (err instanceof SecRefsResolutionError) {
      // Don't announce a reference problem when the references are fine
      // and the credentials aren't - the grouped message below already
      // says what actually happened.
      if (!err.isAuthOnly) {
        console.error("secrefs: failed to resolve one or more secret references:");
      } else {
        console.error("secrefs: could not authenticate to a secret provider.");
      }
      console.error(err.message);
    } else {
      console.error(`secrefs: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
    return;
  }

  const [cmd, ...args] = commandArgs as [string, ...string[]];
  const child = spawn(cmd, args, { stdio: "inherit", env: process.env });

  const forwardedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of forwardedSignals) {
    const handler = () => {
      if (child.pid) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  const cleanupSignalHandlers = () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };

  child.on("error", (err) => {
    cleanupSignalHandlers();
    console.error(`secrefs: failed to start "${cmd}": ${err.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    cleanupSignalHandlers();
    if (signal) {
      // Re-raise the same signal so the parent process exits the way a
      // shell would expect (matching exit-by-signal semantics).
      process.kill(process.pid, signal);
    } else {
      process.exitCode = code ?? 0;
    }
  });
}

async function checkCommand(opts: CommonOptions): Promise<void> {
  try {
    loadEnvFile(opts);
  } catch {
    return;
  }

  const instance = new SecRefs();
  const results = await instance.check();

  if (results.length === 0) {
    console.log("secrefs check: no sec:// references found in the environment.");
    return;
  }

  let failureCount = 0;
  for (const result of results) {
    const icon = result.ok ? "✓" : "✗";
    console.log(`${icon} ${result.key} -> ${result.ref}`);
    if (!result.ok) {
      failureCount += 1;
      console.error(`    ${result.message}`);
    }
  }

  const okCount = results.length - failureCount;
  console.log(`\n${okCount}/${results.length} reference(s) resolved successfully.`);

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

const program = new Command();

program
  .name("secrefs")
  .description("BYOV secret reference engine - expand sec:// references in memory at runtime")
  .version(CLI_VERSION);

program
  .command("run")
  .description("Resolve sec:// references and spawn a child process with the hydrated environment")
  .option("-f, --env-file <path>", "path to a .env file to load before resolving", ".env")
  .option("--no-env-file", "skip loading a .env file")
  .argument("<command...>", "command to run, e.g. secrefs run -- node server.js")
  .action(async (commandArgs: string[], opts: { envFile: string | false }) => {
    await runCommand(commandArgs, opts);
  });

program
  .command("check")
  .description("Validate sec:// references and provider reachability without printing plaintext values")
  .option("-f, --env-file <path>", "path to a .env file to load before checking", ".env")
  .option("--no-env-file", "skip loading a .env file")
  .action(async (opts: { envFile: string | false }) => {
    await checkCommand(opts);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`secrefs: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
