import pc from "picocolors";
import type { EnvironmentView, EnvironmentWrite } from "@preman/core/api/environments.js";

const JSON_INDENT = 2;

export interface EnvRenderOptions {
  json: boolean;
}

export function renderEnvironment(env: EnvironmentView, options: EnvRenderOptions): string {
  if (options.json) return JSON.stringify({ name: env.name, file: env.file, values: env.values }, null, JSON_INDENT);

  const lines = [pc.bold(env.name), pc.dim(env.file), ""];
  const keys = Object.keys(env.values).sort();
  if (keys.length === 0) lines.push(pc.yellow("(no variables)"));
  for (const key of keys) {
    const value = env.values[key] ?? "";
    lines.push(`  ${pc.cyan(key)} = ${value.length > 0 ? value : pc.dim("(empty)")}`);
  }
  return lines.join("\n");
}

export function renderEnvironmentSet(write: EnvironmentWrite, options: EnvRenderOptions): string {
  if (options.json) return JSON.stringify(write, null, JSON_INDENT);
  return `set ${pc.cyan(write.key)}=${write.value} in ${write.name} ${pc.dim(`(${write.file})`)}`;
}
