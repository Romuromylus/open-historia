/*! Pax Colonia — build-time guard: fail the Docker build if Git-LFS map assets
 * are still pointer stubs instead of real bytes.
 *
 * The map ships as LFS-tracked binaries (pmtiles, seed geojson). If the build
 * host cloned the repo without resolving LFS, these are ~130-byte pointer files
 * and the deployed game renders a blank globe. Better to fail the build here,
 * with a clear message, than to ship that. Run from the repo root.
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";

const LFS_MAGIC = "version https://git-lfs";

// Real files are megabytes; LFS pointers are ~130 bytes. min is a coarse floor —
// the magic-bytes check is the real detector.
const REQUIRED = [
  { path: "public/assets/regions.pmtiles", min: 1_000_000 },
  { path: "public/assets/countries.pmtiles", min: 1_000_000 },
  { path: "public/assets/cities.pmtiles", min: 100_000 },
  { path: "public/assets/regions-seed.geojson", min: 100_000 },
  { path: "public/assets/cities-seed.json", min: 100_000 },
  // Both scenario geojsons are LFS-tracked; guard each so a partial `git lfs pull`
  // can't ship one of them as a pointer stub.
  { path: "server/data/scenarios/default/regions.geojson", min: 100_000 },
  { path: "server/data/scenarios/colonization/regions.geojson", min: 100_000 },
];

const readHead = (filePath, bytes = 64) => {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

let ok = true;
for (const { path: filePath, min } of REQUIRED) {
  let size;
  try {
    size = statSync(filePath).size;
  } catch {
    console.error(`  MISSING       ${filePath}`);
    ok = false;
    continue;
  }

  if (readHead(filePath).startsWith(LFS_MAGIC) || size < min) {
    console.error(`  LFS POINTER   ${filePath} (${size} bytes)`);
    ok = false;
  } else {
    console.log(`  ok            ${filePath} (${size} bytes)`);
  }
}

if (!ok) {
  console.error(
    "\nGit-LFS map assets are not resolved. Install git-lfs on the build host and\n" +
      "ensure the repo's LFS objects were pushed, or run `git lfs pull` before building.\n" +
      "See DEPLOY.md.",
  );
  process.exit(1);
}

console.log("All Git-LFS map assets are real bytes.");
