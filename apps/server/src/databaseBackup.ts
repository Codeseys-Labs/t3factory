// @effect-diagnostics nodeBuiltinImport:off -- Shared with the standalone launcher, which cannot load Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const DB_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;

export const databaseBackupFile = (backupDir: string, suffix: (typeof DB_FILE_SUFFIXES)[number]) =>
  NodePath.join(backupDir, suffix === "" ? "database" : `database${suffix}`);

export async function pathExists(target: string): Promise<boolean> {
  try {
    await NodeFSP.access(target);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

// Opened read-write: Windows refuses to flush a handle without write access.
export async function syncFile(filePath: string): Promise<void> {
  const handle = await NodeFSP.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Fsync makes renames durable; Windows returns EPERM and NTFS journals them itself.
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    await handle.close();
  }
}

export function runCp(args: ReadonlyArray<string>, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile("cp", args, { signal }, (error) => resolve(error === null));
  });
}

// macOS fs.copyFile clone flags fall back to full copies.
export async function copyDatabaseFile(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Shared with the standalone launcher, which has no Effect runtime.
  const platform = process.platform;
  // cp -c replaces files and breaks hard links; copy into hard-linked destinations instead.
  const hardLinked =
    platform === "darwin" &&
    ((await NodeFSP.stat(destination).catch(() => undefined))?.nlink ?? 1) > 1;
  const args =
    platform === "darwin" && !hardLinked
      ? ["-c", source, destination]
      : platform === "linux"
        ? ["--reflink=auto", source, destination]
        : undefined;
  if (args !== undefined && (await runCp(args, signal))) return;
  signal?.throwIfAborted();
  await NodeFSP.copyFile(source, destination);
}

// Preserve completed backups; restarted trials may already have changed the live database.
export async function backupDatabaseOnce(
  dbPath: string,
  backupDir: string,
  signal: AbortSignal,
): Promise<void> {
  if (await pathExists(backupDir)) return;

  const stagingDir = `${backupDir}.staging`;
  await NodeFSP.rm(stagingDir, { recursive: true, force: true });
  await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    for (const suffix of DB_FILE_SUFFIXES) {
      signal.throwIfAborted();
      const source = `${dbPath}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      const destination = databaseBackupFile(stagingDir, suffix);
      await copyDatabaseFile(source, destination, signal);
      await syncFile(destination);
    }
    await NodeFSP.rename(stagingDir, backupDir);
    await syncDirectory(NodePath.dirname(backupDir));
  } catch (cause) {
    await NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}
