import { faker } from "@faker-js/faker";
import type { GeneratorTable } from "./types.js";

export type { GeneratorTable };

export const SEED_ENV_VAR = "PREMAN_FAKER_SEED";

const configuredSeed = process.env[SEED_ENV_VAR];
if (configuredSeed !== undefined && configuredSeed.trim() !== "") {
  const seed = Number(configuredSeed);
  if (Number.isInteger(seed)) faker.seed(seed);
}

export function seededFaker(): typeof faker {
  return faker;
}
