import { listVersions, prune } from "../versions/store.js";

export function showVersions(name?: string): void {
  const versions = listVersions(name);

  if (versions.length === 0) {
    console.log("No version snapshots found.");
    return;
  }

  console.log(`\n  Versions${name ? ` for ${name}` : ""}:\n`);
  for (const v of versions) {
    console.log(`    ${v.id}`);
    console.log(`      Name: ${v.name}  Version: ${v.version}`);
    console.log(`      Created: ${v.createdAt}`);
    console.log(`      Path: ${v.snapshotPath}`);
    console.log();
  }
}

export function pruneVersions(keep?: number): void {
  const removed = prune(keep);
  console.log(`Pruned ${removed} old version snapshots.`);
}
