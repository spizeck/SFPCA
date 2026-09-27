// Shared pure helpers for the Postgres backup/restore tooling (#180).
// Kept dependency-free so unit tests can exercise the safety rules
// without Neon, Storage, or a Postgres server.

export const BACKUP_PREFIX = "db-backups/";

// Recovery-history objective: ≥7 days of recoverable points. Keeping 8
// daily objects guarantees a full week even if the oldest is pruned
// moments after a fresh upload lands.
export const BACKUP_RETENTION_COUNT = 8;

// Backup objects are named so lexical sort = chronological order.
export function backupObjectName(date: Date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+/, "")
    .replace("T", "-");
  return `${BACKUP_PREFIX}registry-${stamp}.dump`;
}

// Given all object names under the prefix, return the names that
// should be deleted, keeping the newest `retention` by name order.
// Callers must only run this AFTER the new backup has uploaded
// successfully — pruning before a verified upload could leave zero
// recovery points.
export function staleBackupObjects(
  names: string[],
  retention: number = BACKUP_RETENTION_COUNT,
): string[] {
  const backups = names
    .filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith(".dump"))
    .sort();
  return backups.slice(0, Math.max(0, backups.length - retention));
}

// URL selected for pg_dump. Prefers the dedicated backup URL, then the
// unpooled direct endpoint (long dump transactions are happiest off
// PgBouncer), then the pooled runtime URL as a last resort.
export function pickBackupDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): { url: string; source: string } | null {
  for (const name of [
    "BACKUP_DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "DATABASE_URL",
  ]) {
    const url = env[name];
    if (url && /^postgres(ql)?:\/\//.test(url)) {
      return { url, source: name };
    }
  }
  return null;
}

// For log lines — hostname only, never credentials.
export function urlHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(unparseable URL)";
  }
}
