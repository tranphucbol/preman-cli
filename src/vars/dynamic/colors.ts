import { seededFaker, type GeneratorTable } from "./faker.js";

const faker = seededFaker();
const HEX_COLOR_OPTIONS = { format: "hex", casing: "lower", prefix: "#" } as const;

export const colorGenerators: GeneratorTable = {
  $randomColor: () => faker.color.human(),
  $randomHexColor: () => faker.color.rgb(HEX_COLOR_OPTIONS),
  // Postman groups this hacker abbreviation with its color variables.
  $randomAbbreviation: () => faker.hacker.abbreviation(),
};
