import { spawn } from "node:child_process";
import { promises as fs, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

// ── Update check + confirmed auto-update ─────────────────────────────────────
// Runs once at desk launch (never on the agent subcommands — await/comment/reload
// run in agent loops with JSON stdout and must never block on a prompt). When npm
// has a newer version: prompt on a TTY and, on confirm, run the package manager
// update and re-exec the same command so the desk opens on the new version. Every
// failure path is silent or a one-line warning — an update check must never break
// a launch.

const PKG = "@ymansurozer/galley";
const CHECK_TTL_MS = 24 * 60 * 60 * 1000; // one registry hit per day
const FETCH_TIMEOUT_MS = 2500;

export function currentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "");
  } catch {
    return "";
  }
}

// Plain numeric x.y.z compare — no prerelease ordering (a prerelease segment makes the
// numeric parse fail → false). Good enough: galley publishes plain semver.
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => {
    const parts = v.trim().split(".");
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
    return nums.some(Number.isNaN) ? null : (nums as [number, number, number]);
  };
  const l = parse(latest);
  const c = parse(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i]! !== c[i]!) return l[i]! > c[i]!;
  }
  return false;
}

export type InstallInfo = {
  kind: "global" | "local";
  // The command that updates this install — run on confirm (global) or shown (local).
  command: string[];
};

// Where this CLI lives decides how (and whether) we update it. A path inside the
// current project's node_modules is a local install (devDependency / npx): never
// touch the project's package.json/lockfile — suggest the command instead. Anything
// else is treated as global, with the manager inferred from the install path.
export function detectInstall(cliPath: string, cwd = process.cwd()): InstallInfo {
  const local = path.join(cwd, "node_modules") + path.sep;
  if (cliPath.startsWith(local))
    return { kind: "local", command: ["npm", "i", "-D", `${PKG}@latest`] };
  const p = cliPath.toLowerCase();
  if (p.includes("pnpm"))
    return { kind: "global", command: ["pnpm", "add", "-g", `${PKG}@latest`] };
  if (p.includes(`${path.sep}.bun${path.sep}`))
    return { kind: "global", command: ["bun", "add", "-g", `${PKG}@latest`] };
  if (p.includes("yarn"))
    return { kind: "global", command: ["yarn", "global", "add", `${PKG}@latest`] };
  return { kind: "global", command: ["npm", "i", "-g", `${PKG}@latest`] };
}

// ── 24h throttle cache (~/.galley/update-check.json) ─────────────────────────
function cachePath() {
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  return path.join(home, ".galley", "update-check.json");
}

type CheckCache = { lastCheckedAt?: string; latest?: string };

export async function readCheckCache(): Promise<CheckCache> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeCheckCache(cache: CheckCache) {
  try {
    await fs.mkdir(path.dirname(cachePath()), { recursive: true });
    await fs.writeFile(cachePath(), JSON.stringify(cache, null, 2) + "\n", "utf8");
  } catch {
    /* a failed cache write must not break the launch */
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  const base = process.env.GALLEY_REGISTRY_URL || "https://registry.npmjs.org";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/${encodeURIComponent(PKG)}/latest`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Latest published version, via the daily cache; null when unknown.
async function resolveLatest(): Promise<string | null> {
  const cache = await readCheckCache();
  const fresh = cache.lastCheckedAt && Date.now() - +new Date(cache.lastCheckedAt) < CHECK_TTL_MS;
  if (fresh) return cache.latest ?? null;
  const latest = await fetchLatestVersion();
  if (latest) await writeCheckCache({ lastCheckedAt: new Date().toISOString(), latest });
  return latest;
}

function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(!/^n/i.test(answer.trim())); // empty = yes
    });
  });
}

function runCommand(command: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// Check for a newer release and offer to update. Called only from desk starts.
// On a confirmed global update this re-execs the same command on the new version
// and never returns (the parent lingers only to forward the child's exit code).
export async function maybeOfferUpdate(): Promise<void> {
  if (process.env.GALLEY_NO_UPDATE_CHECK || process.env.GALLEY_UPDATE_REEXEC) return;
  const current = currentVersion();
  const latest = await resolveLatest();
  if (!latest || !current || !isNewer(latest, current)) return;

  let cliPath = process.argv[1] ?? "";
  try {
    cliPath = realpathSync(cliPath); // bin shims are symlinks into the package
  } catch {
    /* keep the raw path */
  }
  const install = detectInstall(cliPath);
  const suggestion = install.command.join(" ");

  const interactive = !!process.stdin.isTTY && !!process.stderr.isTTY;
  if (!interactive || install.kind === "local") {
    console.error(`Galley update available: ${current} → ${latest}. Run \`${suggestion}\`.`);
    return;
  }

  const yes = await promptYesNo(
    `Galley ${latest} is available (you have ${current}). Update now? [Y/n] `,
  );
  if (!yes) return;

  console.error(`Updating: ${suggestion}`);
  const code = await runCommand(install.command);
  if (code !== 0) {
    console.error(`Update failed (exit ${code}) — continuing on ${current}.`);
    return;
  }
  // Relaunch the same command on the new version. argv[1] is the bin path, which the
  // package manager just repointed at the new code; the env flag stops a check loop.
  console.error(`Updated to ${latest} — relaunching…`);
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, GALLEY_UPDATE_REEXEC: "1" },
  });
  const exitCode: number = await new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (c) => resolve(c ?? 0));
  });
  process.exit(exitCode);
}
