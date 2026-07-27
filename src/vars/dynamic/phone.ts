import { seededFaker, type GeneratorTable } from "./faker.js";

const faker = seededFaker();
const PHONE_EXTENSION_DIGITS = 12;
const PHONE_EXTENSION_PATTERN = /^(\d{2})(\d{3})(\d{3})(\d{4})$/;
const PHONE_EXTENSION_REPLACEMENT = "$1-$2-$3-$4";

export const phoneGenerators: GeneratorTable = {
  $randomPhoneNumber: () => faker.phone.number(),
  $randomPhoneNumberExt: () =>
    faker.string.numeric(PHONE_EXTENSION_DIGITS).replace(PHONE_EXTENSION_PATTERN, PHONE_EXTENSION_REPLACEMENT),
  $randomPhoneFormats: () => faker.phone.number(),
};
