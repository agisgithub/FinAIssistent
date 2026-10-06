import { open, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.mjs';

export function secretResolver(root) {
  return async reference => {
    if (typeof reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(reference)) throw new AppError('SECRET_UNAVAILABLE');
    let handle;
    try {
      const directory = await realpath(root);
      const filename = path.join(directory, reference);
      const entry = await lstat(filename);
      if (entry.isSymbolicLink() || !entry.isFile() || await realpath(filename) !== filename) throw new AppError('SECRET_UNAVAILABLE');
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 16384 || stat.ino !== entry.ino || stat.dev !== entry.dev) throw new AppError('SECRET_UNAVAILABLE');
      // POSIX permissions must be owner-only. Windows ACLs are documented in the runbook.
      if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new AppError('SECRET_PERMISSIONS');
      const value = (await handle.readFile('utf8')).replace(/\r?\n$/, '');
      if (!value || /[\r\n\0]/.test(value)) throw new AppError('SECRET_UNAVAILABLE');
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SECRET_UNAVAILABLE');
    } finally { await handle?.close(); }
  };
}
