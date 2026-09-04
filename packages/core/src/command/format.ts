/**
 * The two commands that are the universal currency for "here is the call that works".
 *
 * One union for both directions (decision 3). `import/` reads a paste into a request and
 * `command/` writes a request back out as a command; two identical two-member unions in one
 * tree is the kind of thing the next reader reasonably tries to merge, so it is merged here.
 */
export type CommandFormat = "curl" | "grpcurl";

export const CURL_FORMAT: CommandFormat = "curl";
export const GRPCURL_FORMAT: CommandFormat = "grpcurl";
