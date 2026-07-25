import { randomInt, randomUUID } from "node:crypto";

/**
 * Postman dynamic variables (`{{$guid}}` and friends).
 *
 * Every occurrence is evaluated independently, matching Postman: a body with two
 * `{{$guid}}` placeholders gets two different UUIDs.
 */
const generators: Record<string, () => string> = {
  $guid: () => randomUUID(),
  $randomUUID: () => randomUUID(),
  $timestamp: () => Math.floor(Date.now() / 1000).toString(),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => randomInt(0, 1001).toString(),
};

export function isDynamicVariable(name: string): boolean {
  return name.startsWith("$");
}

export function isSupportedDynamicVariable(name: string): boolean {
  return Object.hasOwn(generators, name);
}

export function generateDynamicValue(name: string): string {
  const gen = generators[name];
  if (!gen) throw new Error(`unsupported dynamic variable {{${name}}}`);
  return gen();
}

export function supportedDynamicVariables(): string[] {
  return Object.keys(generators);
}
