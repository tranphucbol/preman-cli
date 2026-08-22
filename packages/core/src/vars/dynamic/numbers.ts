import { seededFaker, type GeneratorTable } from "./faker.js";

const faker = seededFaker();
const DIGIT_MIN = 0;
const DIGIT_MAX = 9;
const DEFAULT_INTERVAL_MIN = 0;
const DEFAULT_INTERVAL_MAX = 1000;

export const numberGenerators: GeneratorTable = {
  $randomBoolean: () => String(faker.datatype.boolean()),
  $randomDigit: () => String(faker.number.int({ min: DIGIT_MIN, max: DIGIT_MAX })),
  $randomAlphaNumeric: () => faker.string.alphanumeric(),
  // Postman's token syntax has no arguments, so use the same default interval as randomInt.
  $randomIntFromInterval: () => String(faker.number.int({ min: DEFAULT_INTERVAL_MIN, max: DEFAULT_INTERVAL_MAX })),
};
