import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { CliError } from "@preman/core/errors.js";

export type DataRow = Record<string, string>;

export interface LoadedData {
  path: string;
  rows: DataRow[];
}

const JSON_EXTENSION = ".json";
const CSV_EXTENSION = ".csv";
const SUPPORTED_EXTENSIONS: readonly string[] = [JSON_EXTENSION, CSV_EXTENSION];

function normaliseRow(row: Record<string, unknown>): DataRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value === null
        ? ""
        : typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            typeof value === "bigint" ||
            typeof value === "symbol"
          ? String(value)
          : (JSON.stringify(value) ?? ""),
    ]),
  );
}

function noRows(path: string): CliError {
  return new CliError(`iteration data "${path}" contains no rows`);
}

function parseJsonRows(path: string, source: string): DataRow[] {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new CliError(`could not parse iteration data "${path}" as JSON`, {
      details: [(cause as Error).message],
    });
  }

  if (!Array.isArray(value) || value.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
    throw new CliError(`iteration data "${path}" expects an array of objects`);
  }
  if (value.length === 0) throw noRows(path);
  return value.map((row) => normaliseRow(row as Record<string, unknown>));
}

function parseCsvRows(path: string, source: string): DataRow[] {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = parse(source, { columns: true, skip_empty_lines: true, trim: true });
  } catch (cause) {
    throw new CliError(`could not parse iteration data "${path}" as CSV`, {
      details: [(cause as Error).message],
    });
  }
  if (rows.length === 0) throw noRows(path);
  return rows.map(normaliseRow);
}

export async function loadIterationData(inputPath: string): Promise<LoadedData> {
  const path = resolve(inputPath);
  const extension = extname(path).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new CliError(`iteration data "${path}" expects ${JSON_EXTENSION} or ${CSV_EXTENSION}`);
  }

  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    throw new CliError(`could not read iteration data "${path}"`, {
      details: [(cause as Error).message],
    });
  }

  return {
    path,
    rows: extension === JSON_EXTENSION ? parseJsonRows(path, source) : parseCsvRows(path, source),
  };
}

export function rowFor(rows: DataRow[], iteration: number): DataRow | undefined {
  return rows.length === 0 ? undefined : rows[iteration % rows.length];
}
