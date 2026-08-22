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

/** Extra specifiers accepted by require() that are not bare package names. */
export const SANDBOX_ALIASES: Readonly<Record<string, string>> = {
  "csv-parse/lib/sync": "csv-parse/sync",
};
