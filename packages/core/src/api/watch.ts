import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

const WATCH_DEBOUNCE_MS = 50;
/** Everything a workspace keeps on disk. Nothing outside these can change a catalog. */
const WATCHED_DIRS = ["postman", ".postman"];

export interface WatchHandle {
  close(): void;
}

export interface WatchOptions {
  debounceMs?: number;
  /**
   * Called when a directory cannot be watched. A degraded watcher must never be
   * silent: external edits simply stop arriving, which looks like data loss.
   */
  onDegraded?: (message: string) => void;
}

/**
 * Watch a workspace for external edits, coalescing bursts into one call.
 *
 * Recursive watching is native on macOS and Windows, and since Node 20.13 it is accepted on
 * Linux too — so the fallback below now fires only where `watch` throws outright, not on Linux
 * as an earlier version of this comment claimed. Rather than build a per-directory watcher tree
 * that silently misses new subdirectories, the fallback reports the degradation and watches the
 * top level only. The caller decides what to tell the user.
 *
 * Being accepted on Linux is not the same as being equivalent there. Node backs recursion with
 * one inotify watch per file, and a `rename` over a watched file drops its watch for good, so
 * every external edit to a file the app has already saved — and `workspace/atomic.ts` saves by
 * temp-plus-rename — is missed. Nothing here detects that, so nothing reports it: on Linux this
 * watcher is silently partial, which `docs/decisions/032` records rather than fixes.
 */
export function watchWorkspace(
  root: string,
  onChange: (paths: string[]) => void,
  options: WatchOptions = {},
): WatchHandle {
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  const watchers: FSWatcher[] = [];
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const flush = (): void => {
    timer = undefined;
    if (closed || pending.size === 0) return;
    const paths = [...pending];
    pending.clear();
    onChange(paths);
  };

  const record = (dir: string, filename: string | null): void => {
    if (closed || filename === null) return;
    pending.add(join(dir, filename));
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  for (const name of WATCHED_DIRS) {
    const dir = join(root, name);
    if (!existsSync(dir)) continue;
    try {
      watchers.push(watch(dir, { recursive: true }, (_event, filename) => record(dir, filename)));
    } catch (cause) {
      options.onDegraded?.(`recursive watching is unavailable for ${dir}: ${(cause as Error).message}`);
      try {
        watchers.push(watch(dir, (_event, filename) => record(dir, filename)));
      } catch (fallbackCause) {
        options.onDegraded?.(`cannot watch ${dir}: ${(fallbackCause as Error).message}`);
      }
    }
  }

  if (watchers.length === 0) options.onDegraded?.(`nothing to watch under ${root}; external edits will be missed`);

  return {
    close: () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
    },
  };
}
