#!/usr/bin/env node
/**
 * Proves the build-time backend-exclusion gate in vite.config.ts rejects
 * server code.
 *
 * Each probe is a module that imports one backend target. The probe imports
 * the real file under the repository-root `src/`, so a missing file fails the
 * run instead of looking "blocked". A case passes only when the build fails
 * with the gate's own diagnostic, not with an unrelated error.
 *
 * One control probe imports `@trpc/server`, which the client needs for the
 * type-only router import. Its build must succeed.
 *
 * Run from client/ after `npm ci --include=dev`:
 *   node scripts/check-boundary.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const client = resolve(import.meta.dirname, "..");
const repoRoot = resolve(client, "..");
const sourceRoot = join(repoRoot, "src");
const vite = join(client, "node_modules", ".bin", "vite");
const outDir = mkdtempSync(join(tmpdir(), "boundary-"));

/** Targets under the repository-root `src/`. Each must exist on disk. */
const serverFiles = {
  "root env module": "env.ts",
  "root lib module": "lib/entitlements.ts",
  "root services module": "services/follows.ts",
  "root db schema": "db/schema.ts",
};

/** Packages that must never reach the browser. */
const serverPackages = [
  ["drizzle-orm package", "import { eq } from \"drizzle-orm\"; console.log(eq);"],
  ["ioredis package", "import Redis from \"ioredis\"; console.log(Redis);"],
  ["grammy package", "import { Bot } from \"grammy\"; console.log(Bot);"],
  ["@grammyjs package", "import { autoRetry } from \"@grammyjs/auto-retry\"; console.log(autoRetry);"],
  ["@aws-sdk package", "import { S3Client } from \"@aws-sdk/client-s3\"; console.log(S3Client);"],
  ["postgres package", "import postgres from \"postgres\"; console.log(postgres);"],
];

const probes = [
  ...Object.entries(serverFiles).map(([name, file]) => ({
    name,
    // Absolute path: no reliance on the probe's own depth, and the file must exist.
    source: `import * as target from ${JSON.stringify(join(sourceRoot, file))}; console.log(target);`,
    expect: "Server module included in client bundle",
  })),
  ...serverPackages.map(([name, source]) => ({
    name,
    source,
    expect: "Server package",
  })),
];

const control = {
  name: "control: @trpc/server stays allowed",
  source: "import { initTRPC } from \"@trpc/server\"; console.log(initTRPC);",
};

/** Write a probe entry and its config, build it, and remove the probe files. */
function build(entry) {
  const dir = mkdtempSync(join(client, "src", ".boundary-"));
  const file = join(dir, "entry.ts");
  writeFileSync(file, entry, "utf8");
  const config = join(dir, "vite.config.mjs");
  writeFileSync(
    config,
    `// Reuse the project config so the real boundary plugin is under test.
const { default: project } = await import(${JSON.stringify(join(client, "vite.config.ts"))});
export default {
  ...project,
  root: ${JSON.stringify(client)},
  cacheDir: ${JSON.stringify(join(dir, "cache"))},
  build: { outDir: ${JSON.stringify(outDir)}, emptyOutDir: true, lib: { entry: ${JSON.stringify(file)}, formats: ["es"], fileName: "probe" } },
};
`,
    "utf8",
  );
  const result = spawnSync(vite, ["build", "--config", config], { cwd: client, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

const missing = Object.values(serverFiles).filter((file) => !existsSync(join(sourceRoot, file)));
if (missing.length) {
  console.error(`Probe targets are missing under ${sourceRoot}: ${missing.join(", ")}`);
  process.exit(1);
}

let failures = 0;

for (const probe of probes) {
  const result = build(probe.source);
  const failed = result.status !== 0;
  const gateHit = result.output.includes(probe.expect);
  if (!failed || !gateHit) failures += 1;
  const status = !failed ? "LEAKED " : !gateHit ? "WRONG  " : "blocked";
  const detail = gateHit
    ? ` — ${result.output.match(new RegExp(`${probe.expect}[^\\n]*`))[0].replace(/ imported by .*$/, "")}`
    : failed
      ? ` — failed without the gate diagnostic: ${result.output.split("\n").find((l) => l.trim()) ?? "no output"}`
      : "";
  console.log(`${status} ${probe.name}${detail}`);
}

{
  const result = build(control.source);
  if (result.status !== 0) {
    failures += 1;
    console.log(`FAILED  ${control.name} — ${result.output.split("\n").find((l) => l.trim()) ?? "no output"}`);
  } else {
    console.log(`allowed ${control.name}`);
  }
}

rmSync(outDir, { recursive: true, force: true });
console.log(
  `\n${probes.length} backend probes blocked, 1 control allowed, ${failures} failure(s). ` +
    `Repository root: ${relative(process.cwd(), repoRoot) || "."}`,
);
process.exit(failures === 0 ? 0 : 1);
