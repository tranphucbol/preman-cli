/** Names a script may pass to require(); also the bundler's external list. */
export const SANDBOX_PACKAGES = [
  "ajv",
  "atob",
  "btoa",
  "chai",
  "cheerio",
  "crypto-js",
  "csv-parse/lib/sync",
  "lodash",
  "moment",
  "tv4",
  "uuid",
  "xml2js",
] as const satisfies readonly string[];

/**
 * The only faker specifier the engine may reach, kept here because all three bundlers externalise
 * it and none of them may disagree. It is the locale entry rather than the barrel: see
 * `vars/dynamic/faker.ts` for why, and `test/perf.test.ts` for the guard that holds it.
 */
export const FAKER_MODULE = "@faker-js/faker/locale/en";

/** Extra specifiers accepted by require() that are not bare package names. */
export const SANDBOX_ALIASES: Readonly<Record<string, string>> = {
  "csv-parse/lib/sync": "csv-parse/sync",
};
