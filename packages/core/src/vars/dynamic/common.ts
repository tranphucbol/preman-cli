import { randomInt, randomUUID } from "node:crypto";
import type { GeneratorTable } from "./types.js";

const RANDOM_INT_MIN = 0;
const RANDOM_INT_MAX_EXCLUSIVE = 1001;
const MILLISECONDS_PER_SECOND = 1000;

export const commonGenerators: GeneratorTable = {
  $guid: () => randomUUID(),
  $randomUUID: () => randomUUID(),
  $timestamp: () => Math.floor(Date.now() / MILLISECONDS_PER_SECOND).toString(),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => randomInt(RANDOM_INT_MIN, RANDOM_INT_MAX_EXCLUSIVE).toString(),
};
