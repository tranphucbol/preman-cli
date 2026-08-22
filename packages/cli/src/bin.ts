#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pc from "picocolors";
import { PremanError, EXIT } from "@preman/core/errors.js";
import { main } from "./main.js";

/* c8 ignore start -- process wiring, exercised by running the binary */
export function isDirectEntrypoint(entrypoint: string | undefined, moduleUrl: string): boolean {
  return entrypoint !== undefined && moduleUrl === pathToFileURL(realpathSync(entrypoint)).href;
}

const isDirectRun = isDirectEntrypoint(process.argv[1], import.meta.url);

if (isDirectRun) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof PremanError) {
      process.stderr.write(`${pc.red("error:")} ${error.message}\n`);
      for (const detail of error.details) process.stderr.write(`${detail}\n`);
      process.exitCode = error.exitCode;
    } else {
      process.stderr.write(`${pc.red("error:")} ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = EXIT.CLI;
    }
  }
}
/* c8 ignore stop */
