import path from "node:path";

/** Background UI checks require an explicit, independently named test profile. */
export function backgroundSmokeEnabled(argv: string[], env: NodeJS.ProcessEnv): boolean {
  if (env.POE2_SMOKE_BACKGROUND !== "1") return false;
  const profiles = argv.flatMap((arg, index) => arg.startsWith("--user-data-dir=")
    ? [arg.slice("--user-data-dir=".length)] : arg === "--user-data-dir" ? [argv[index + 1] ?? ""] : []);
  const expected = env.POE2_SMOKE_USER_DATA_DIR;
  if (profiles.length !== 1 || !profiles[0] || !expected || !path.isAbsolute(profiles[0]) || !path.isAbsolute(expected) ||
      path.resolve(profiles[0]) !== path.resolve(expected) || path.resolve(expected) === path.parse(expected).root) {
    throw new Error("Background smoke requires a matching explicit isolated user-data directory.");
  }
  return true;
}
