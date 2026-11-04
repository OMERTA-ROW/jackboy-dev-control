import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Expected digest comes from the same run's prepare job output, never a downloaded sidecar.
export function verifyCodeEvidence(file, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? "")) throw new Error("Missing trusted CODE patch digest.");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 500_000)
    throw new Error("Invalid CODE patch artifact.");
  const actual = createHash("sha256").update(readFileSync(file)).digest();
  if (!timingSafeEqual(actual, Buffer.from(expected, "hex")))
    throw new Error("CODE patch artifact does not match the prepared digest.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  verifyCodeEvidence(process.argv[2], process.argv[3]);
