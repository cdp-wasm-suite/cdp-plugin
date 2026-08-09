#!/usr/bin/env node
// Refresh src/cdp-sampler/CDPSampler.h — the shared sampler DSP header that IS
// committed to this repo and compiled straight into the plugin.
//
// cdp-sampler is the single source of truth (see the cdp-sampler repo); this
// copy is a vendored artefact, never the place to edit. It is committed rather
// than fetched at configure time because it is C++ *source*: fetching it would
// put Node and a network round-trip into the C++ build path for one header, and
// a clean CI runner builds the plugin with neither.
//
// Two sources:
//
//   npm run vendor:sampler
//       The public cdp-sampler repo at a resolved commit — the pin recorded in
//       src/cdp-sampler/VENDOR.json. This is what a release should vendor, and
//       the only form `--check` can verify. No auth: the repo is public.
//       CDP_SAMPLER_REF=<branch|tag|sha> picks something other than main.
//
//   npm run vendor:sampler:local
//   CDP_SAMPLER_DIR=/path/to/cdp-sampler npm run vendor:sampler
//       Take the header from a local cdp-sampler checkout, for iterating on the
//       DSP across both repos before publishing. Marks the pin as local, which
//       makes `--check` (and therefore CI) fail until it is re-vendored from a
//       pushed commit. Defaults to a sibling ../cdp-sampler.
//
//   node scripts/vendor-sampler.mjs --check
//       Verify only, write nothing: the committed header must match its
//       recorded hash AND still match upstream at the pinned commit. This is
//       the CI drift gate.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "src", "cdp-sampler", "CDPSampler.h");
const PIN = join(ROOT, "src", "cdp-sampler", "VENDOR.json");

const REPO = "cdp-wasm-suite/cdp-sampler";
const PATH_IN_REPO = "include/CDPSampler.h";
const REMOTE = `https://github.com/${REPO}.git`;

const check = process.argv.includes("--check");
const useLocal = process.argv.includes("--local") || !!process.env.CDP_SAMPLER_DIR;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const fail = (...lines) => {
  for (const line of lines) console.error(line);
  process.exit(1);
};

function resolveRemoteCommit(ref) {
  // git ls-remote over https needs no auth for a public repo, and resolves a
  // branch/tag to the immutable sha we pin (a tag can be moved; a sha cannot).
  const out = execFileSync("git", ["ls-remote", REMOTE, ref], { encoding: "utf8" }).trim();
  if (!out) fail(`✗ ${REPO} has no ref '${ref}'.`);
  return out.split(/\s+/)[0];
}

async function fetchAtCommit(commit) {
  const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${PATH_IN_REPO}`;
  const res = await fetch(url);
  if (!res.ok) fail(`✗ GET ${url} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

function fromLocalCheckout() {
  const dir = process.env.CDP_SAMPLER_DIR
    ? resolve(process.env.CDP_SAMPLER_DIR)
    : resolve(ROOT, "..", "cdp-sampler");
  const src = join(dir, PATH_IN_REPO);
  if (!existsSync(src)) {
    fail(
      `✗ cdp-sampler checkout not found at ${dir} (no ${PATH_IN_REPO}).`,
      "  Set CDP_SAMPLER_DIR=/path/to/cdp-sampler, or drop --local to vendor from the public repo.",
    );
  }
  const git = (...args) => {
    try {
      return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const commit = git("rev-parse", "HEAD") || "unknown";
  const dirty = git("status", "--porcelain", "--", PATH_IN_REPO) !== "";
  return { dir, src, commit, dirty };
}

// A sanity check on the bytes, so a redirect page or a truncated read can never
// land in the build as a "header".
function assertLooksLikeTheHeader(buf, where) {
  const text = buf.toString("utf8");
  if (!text.includes("#pragma once") || !text.includes("class Sampler")) {
    fail(`✗ ${where} does not look like CDPSampler.h (no '#pragma once' / 'class Sampler').`);
  }
}

async function readPin() {
  try {
    return JSON.parse(await readFile(PIN, "utf8"));
  } catch {
    return null;
  }
}

// --- check: verify the committed copy, write nothing ------------------------
if (check) {
  const pin = await readPin();
  if (!pin) fail(`✗ ${PIN} is missing — run \`npm run vendor:sampler\` and commit the result.`);

  let vendored;
  try {
    vendored = await readFile(DEST);
  } catch {
    fail(`✗ ${DEST} is missing — run \`npm run vendor:sampler\` and commit the result.`);
  }

  const localHash = sha256(vendored);
  if (localHash !== pin.sha256) {
    fail(
      "✗ src/cdp-sampler/CDPSampler.h has been edited in this repo.",
      `  recorded: ${pin.sha256}`,
      `  actual:   ${localHash}`,
      "  cdp-sampler is the source of truth: make the change there, publish it,",
      "  then re-run `npm run vendor:sampler` here.",
    );
  }

  if (pin.source !== "repo") {
    fail(
      `✗ the vendored header is pinned to a ${pin.source} source (${pin.dir ?? "?"}).`,
      "  That is fine while iterating, but must not ship: push the cdp-sampler change,",
      "  then re-run `npm run vendor:sampler` (no --local) and commit the pin.",
    );
  }

  const upstream = await fetchAtCommit(pin.commit);
  if (sha256(upstream) !== localHash) {
    fail(
      `✗ the vendored header no longer matches ${REPO}@${pin.commit.slice(0, 12)}.`,
      "  (a force-push upstream, or a hand-edited VENDOR.json) — re-vendor to resolve.",
    );
  }

  console.log(`✓ CDPSampler.h matches ${REPO}@${pin.commit.slice(0, 12)} (${pin.ref})`);

  // Upstream moving on is normal and must not fail unrelated PRs — just say so.
  try {
    const head = resolveRemoteCommit("refs/heads/main");
    if (head !== pin.commit) {
      const msg = `cdp-sampler main is at ${head.slice(0, 12)}, this repo is pinned to ${pin.commit.slice(0, 12)} — run \`npm run vendor:sampler\` to update.`;
      console.log(`::notice title=cdp-sampler is behind::${msg}`);
      console.log(`ℹ ${msg}`);
    }
  } catch {
    console.log("ℹ could not reach cdp-sampler to compare against main (skipping staleness note)");
  }

  process.exit(0);
}

// --- vendor: fetch and write ------------------------------------------------
let bytes;
let pin;

if (useLocal) {
  const { dir, src, commit, dirty } = fromLocalCheckout();
  bytes = await readFile(src);
  assertLooksLikeTheHeader(bytes, src);
  pin = { source: "local", repo: REPO, path: PATH_IN_REPO, dir, commit, dirty, sha256: sha256(bytes) };
  console.log(`→ vendored from local checkout ${dir}${dirty ? " (uncommitted changes)" : ""}`);
  console.warn("⚠ local source: CI's drift check will fail until this is re-vendored from a pushed commit.");
} else {
  const ref = process.env.CDP_SAMPLER_REF || "refs/heads/main";
  const commit = resolveRemoteCommit(ref);
  bytes = await fetchAtCommit(commit);
  assertLooksLikeTheHeader(bytes, `${REPO}@${commit.slice(0, 12)}:${PATH_IN_REPO}`);
  pin = { source: "repo", repo: REPO, path: PATH_IN_REPO, ref, commit, sha256: sha256(bytes) };
  console.log(`→ vendored ${REPO}@${commit.slice(0, 12)} (${ref})`);
}

await mkdir(dirname(DEST), { recursive: true });
// Byte-identical to upstream — no banner, so the drift check is a plain hash
// compare and "the plugin and the AudioWorklet run the same code" stays literal.
// Provenance lives in VENDOR.json beside it.
await writeFile(DEST, bytes);
await writeFile(
  PIN,
  JSON.stringify(
    {
      _comment:
        "Provenance for the vendored CDPSampler.h. Do not edit that header here — " +
        "change it in the cdp-sampler repo and re-run `npm run vendor:sampler`. " +
        "Verified in CI by `node scripts/vendor-sampler.mjs --check`.",
      ...pin,
    },
    null,
    2,
  ) + "\n",
);

console.log("✓ wrote src/cdp-sampler/CDPSampler.h + VENDOR.json (commit the diff)");
