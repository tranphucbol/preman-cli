import { PremanError } from "@preman/core/errors.js";
import { addressGenerators } from "./addresses.js";
import { assembleGeneratorTables } from "./assemble.js";
import { colorGenerators } from "./colors.js";
import { commonGenerators } from "./common.js";
import { databaseGenerators } from "./database.js";
import { dateGenerators } from "./dates.js";
import { fileGenerators } from "./files.js";
import { financeGenerators } from "./finance.js";
import { internetGenerators } from "./internet.js";
import { nameGenerators } from "./names.js";
import { numberGenerators } from "./numbers.js";
import { phoneGenerators } from "./phone.js";
import { nearestNames } from "./suggest.js";
import { textGenerators } from "./text.js";

export { assembleGeneratorTables } from "./assemble.js";
export { nearestNames } from "./suggest.js";
export type { Generator, GeneratorTable } from "./types.js";

const generators = assembleGeneratorTables([
  commonGenerators,
  textGenerators,
  nameGenerators,
  addressGenerators,
  phoneGenerators,
  internetGenerators,
  financeGenerators,
  colorGenerators,
  databaseGenerators,
  dateGenerators,
  fileGenerators,
  numberGenerators,
]);
const supportedNames = Object.keys(generators).sort();

export function isDynamicVariable(name: string): boolean {
  return name.startsWith("$");
}

export function isSupportedDynamicVariable(name: string): boolean {
  return Object.hasOwn(generators, name);
}

export function unsupportedDynamicVariableDetails(name: string): string[] {
  const suggestions = nearestNames(name, supportedNames);
  return suggestions.length > 0
    ? [`did you mean: ${suggestions.map((candidate) => `{{${candidate}}}`).join(", ")}`]
    : [`${supportedNames.length} dynamic variables are supported`];
}

export function generateDynamicValue(name: string): string {
  const generator = generators[name];
  if (!generator) {
    throw new PremanError(`unsupported dynamic variable {{${name}}}`, {
      details: unsupportedDynamicVariableDetails(name),
    });
  }
  return generator();
}

export function supportedDynamicVariables(): string[] {
  return [...supportedNames];
}
