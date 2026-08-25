// The locale entry, not the barrel. `@faker-js/faker` statically imports all 71 locales plus
// `base` and constructs a Faker for each at module scope: 81 files and 3.8MB, against 4 files and
// 478KB here. Cold that is ~1.9s versus ~130ms, warm 136ms versus 12ms. It buys nothing, because
// the binding is the same object either way - `locale/en.js` and `index.js` re-export `faker` from
// the same chunk - and because Postman's dynamic variables have no locale syntax for preman to be
// compatible with. Should one ever appear, load that one locale by tag rather than all of them.
import { faker } from "@faker-js/faker/locale/en";
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
