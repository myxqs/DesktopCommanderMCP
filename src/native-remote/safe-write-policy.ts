import fs from 'node:fs/promises';
import path from 'node:path';

export const REMOTE_WRITE_ACTIONS = Object.freeze(['create_directory'] as const);
export type RemoteWriteAction = typeof REMOTE_WRITE_ACTIONS[number];

function normalizeForCompare(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function rejectPathSyntax(requestedPath: string): void {
  if (!requestedPath || requestedPath.includes('\0')) throw new Error('Remote write path is invalid');
  if (process.platform === 'win32') {
    const raw = requestedPath.replace(/\//g, '\\');
    if (raw.startsWith('\\\\') || raw.startsWith('\\?\\') || raw.startsWith('\\.\\')) {
      throw new Error('UNC and Windows device paths are not permitted for remote writes');
    }
  }
}

const SENSITIVE_SEGMENTS = new Set([
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.desktop-commander-device',
  'nativerdc', 'credentials', 'credential manager',
]);

function sensitivePath(value: string): boolean {
  const parts = normalizeForCompare(value).replace(/\//g, '\\').split('\\').filter(Boolean);
  return parts.some((part) => SENSITIVE_SEGMENTS.has(part.toLowerCase()));
}

async function realWriteRoots(writeRoots: string[]): Promise<string[]> {
  const unique = new Set<string>();
  for (const root of writeRoots.slice(0, 8)) {
    if (typeof root !== 'string' || !root.trim()) continue;
    rejectPathSyntax(root);
    try {
      const real = await fs.realpath(path.resolve(root));
      unique.add(normalizeForCompare(real));
    } catch {
      // Missing roots grant nothing.
    }
  }
  return [...unique];
}
export async function authorizeCreateDirectoryPath(
  requestedPath: string,
  writeRoots: string[],
): Promise<string> {
  rejectPathSyntax(requestedPath);
  const roots = await realWriteRoots(writeRoots);
  if (roots.length === 0) throw new Error('No Native RDC write roots are configured');

  const resolved = path.resolve(requestedPath);
  if (sensitivePath(resolved)) throw new Error('Remote write target is sensitive and denied');

  const parent = path.dirname(resolved);
  let realParent: string;
  try {
    realParent = await fs.realpath(parent);
  } catch {
    throw new Error('Remote write parent directory must already exist');
  }
  const comparableParent = normalizeForCompare(realParent);
  if (!roots.some((root) => isWithin(root, comparableParent))) {
    throw new Error('Remote write target is outside approved roots');
  }

  const target = path.join(realParent, path.basename(resolved));
  const comparableTarget = normalizeForCompare(target);
  if (!roots.some((root) => isWithin(root, comparableTarget))) {
    throw new Error('Remote write target is outside approved roots');
  }
  if (sensitivePath(target)) throw new Error('Remote write target is sensitive and denied');

  try {
    const existing = await fs.realpath(target);
    const stat = await fs.stat(existing);
    if (!stat.isDirectory()) throw new Error('Remote write target already exists and is not a directory');
    throw new Error('Remote write target directory already exists');
  } catch (error) {
    if (error instanceof Error && /already exists/.test(error.message)) throw error;
  }

  return target;
}

export async function validateRemoteWriteArguments(
  action: string,
  args: unknown,
  writeRoots: string[],
): Promise<Record<string, unknown>> {
  if (action !== 'create_directory') throw new Error('Remote write action is not permitted');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Remote write arguments are invalid');
  const input = args as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || typeof input.path !== 'string' || !input.path.trim()) {
    throw new Error('create_directory requires exactly one non-empty path');
  }
  return { path: await authorizeCreateDirectoryPath(input.path, writeRoots) };
}
