import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = resolve(ROOT, 'data', 'cover-package-build', '.cover-write.lock');

function now() {
  return new Date().toISOString();
}

async function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0);
      return 'running';
    } catch {
      return null;
    }
  }
  const child = await import('node:child_process');
  return new Promise((resolveResult) => {
    child.execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { windowsHide: true, timeout: 4000 },
      (error, stdout) => resolveResult(error || !stdout.trim() ? null : stdout.trim()),
    );
  });
}

async function stale(record) {
  const current = await processStartTime(Number(record?.pid));
  return !current || current !== String(record?.processStartedAt || '');
}

export async function acquireCoverWriteLock(owner, jobId = randomUUID()) {
  const processStartedAt = await processStartTime(process.pid);
  const record = { owner, jobId, pid: process.pid, processStartedAt, createdAt: now() };
  await (
    await import('node:fs/promises')
  ).mkdir(resolve(ROOT, 'data', 'cover-package-build'), { recursive: true });
  try {
    const handle = await open(LOCK_PATH, 'wx');
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await handle.close();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let existing = null;
    try {
      existing = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
    } catch {
      existing = { owner: 'unknown' };
    }
    if (!(await stale(existing))) {
      throw new Error(
        `Cover data is locked by ${existing.owner || 'another process'} (PID ${existing.pid || 'unknown'}).`,
      );
    }
    await rm(LOCK_PATH, { force: true });
    const handle = await open(LOCK_PATH, 'wx');
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await handle.close();
  }
  return {
    path: LOCK_PATH,
    record,
    async release() {
      try {
        const current = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
        if (current.jobId === record.jobId) await rm(LOCK_PATH, { force: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}

export async function sha256File(path) {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

export async function canonicalHash(path) {
  try {
    const details = await stat(path);
    return details.isFile() ? sha256File(path) : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
