import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PremanError } from "@preman/core/errors.js";

export interface FileReaderOptions {
  /** Root that relative paths resolve against and, by default, may not escape. */
  workingDir: string;
  /** When true, paths outside workingDir are permitted. */
  allowOutside: boolean;
}

export interface FileReader {
  read(src: string, label: string): Buffer;
  resolve(src: string, label: string): string;
}

const ESCAPE_HINT = "pass --insecure-file-read to allow it";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Resolve and read request files without letting a synced workspace roam the host by default. */
export function fileReader(options: FileReaderOptions): FileReader {
  let workingDir: string;
  try {
    workingDir = realpathSync(resolve(options.workingDir));
  } catch (cause) {
    throw new PremanError(`working directory "${options.workingDir}" could not be resolved`, {
      details: [errorMessage(cause)],
    });
  }

  const resolveFile = (src: string, label: string): string => {
    const candidate = isAbsolute(src) ? src : resolve(workingDir, src);
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch (cause) {
      throw new PremanError(`${label} file "${src}" could not be resolved`, {
        details: [errorMessage(cause)],
      });
    }

    const fromRoot = relative(workingDir, real);
    const outside = fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
    if (outside && !options.allowOutside) {
      throw new PremanError(`${label} file "${src}" is outside the working directory`, {
        details: [`working directory: ${workingDir}`, ESCAPE_HINT],
      });
    }
    return real;
  };

  return {
    resolve: resolveFile,
    read(src, label) {
      const path = resolveFile(src, label);
      let stats;
      try {
        stats = statSync(path);
      } catch (cause) {
        throw new PremanError(`${label} file "${src}" could not be inspected`, {
          details: [errorMessage(cause)],
        });
      }
      if (!stats.isFile()) {
        throw new PremanError(`${label} file "${src}" is not a regular file`);
      }
      try {
        return readFileSync(path);
      } catch (cause) {
        throw new PremanError(`${label} file "${src}" could not be read`, {
          details: [errorMessage(cause)],
        });
      }
    },
  };
}
