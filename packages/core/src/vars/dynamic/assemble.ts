import type { GeneratorTable } from "./types.js";

export function assembleGeneratorTables(tables: readonly GeneratorTable[]): GeneratorTable {
  const assembled: GeneratorTable = {};
  for (const table of tables) {
    for (const [name, generator] of Object.entries(table)) {
      if (Object.hasOwn(assembled, name)) throw new Error(`duplicate dynamic variable generator: ${name}`);
      assembled[name] = generator;
    }
  }
  return assembled;
}
