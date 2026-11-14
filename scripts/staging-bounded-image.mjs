import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function copyBoundedMigrations(source, destination) {
  const journalPath = join(source, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const entries = journal.entries.slice(0, 65);
  if (
    journal.dialect !== "postgresql" ||
    journal.version !== "7" ||
    entries.length !== 65 ||
    entries[43]?.tag !== "0043_code_provider_gateway" ||
    entries[64]?.tag !== "0064_omni_configuration_probe" ||
    entries.some(
      (entry, index) =>
        entry.idx !== index ||
        !new RegExp(`^${String(index).padStart(4, "0")}_[a-z0-9_]+$`).test(entry.tag),
    )
  )
    throw new Error("migration_cutoff_mismatch");
  await mkdir(join(destination, "meta"), { recursive: true });
  for (const entry of entries) {
    await copyFile(join(source, `${entry.tag}.sql`), join(destination, `${entry.tag}.sql`));
  }
  await writeFile(
    join(destination, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  return entries.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const count = await copyBoundedMigrations(process.argv[2], process.argv[3]);
    console.log(`bounded_migration_files:${count}`);
  } catch (error) {
    const category =
      error?.message === "migration_cutoff_mismatch"
        ? "migration_cutoff_mismatch"
        : error?.code === "ENOENT"
          ? "migration_file_missing"
          : "image_prepare_failed";
    console.error(`image_prepare:${category}`);
    process.exitCode = 1;
  }
}
