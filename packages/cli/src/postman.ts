import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Postman Desktop keeps its application data on this platform.
 *
 * The CLI's answer, not the engine's: `migrateCloudWorkspace` takes the directory as an
 * argument so a test can point it anywhere, and the desktop app asks Electron
 * (`app.getPath("appData")`) rather than guessing. This is the guess a terminal has to make.
 */

const POSTMAN_DIR_NAME = "Postman";
const MACOS = "darwin";
const WINDOWS = "win32";
const MACOS_SEGMENTS = ["Library", "Application Support"] as const;
const LINUX_SEGMENTS = [".config"] as const;
const WINDOWS_SEGMENTS = ["AppData", "Roaming"] as const;

export function defaultPostmanAppData(): string {
  if (process.platform === MACOS) return join(homedir(), ...MACOS_SEGMENTS, POSTMAN_DIR_NAME);
  if (process.platform === WINDOWS) {
    // Electron writes under %APPDATA%, which is this path unless the user moved it.
    return join(process.env.APPDATA ?? join(homedir(), ...WINDOWS_SEGMENTS), POSTMAN_DIR_NAME);
  }
  return join(homedir(), ...LINUX_SEGMENTS, POSTMAN_DIR_NAME);
}
