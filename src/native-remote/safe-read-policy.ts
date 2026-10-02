import fs from 'node:fs/promises';
import path from 'node:path';

export const REMOTE_READ_TOOLS = Object.freeze([
  'get_config',
  'list_processes',
  'list_directory',
  'get_file_info',
  'read_file',
] as const);

export type RemoteReadTool = typeof REMOTE_READ_TOOLS[number];

const REMOTE_READ_TOOL_SET = new Set<string>(REMOTE_READ_TOOLS);
const SAFE_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.jsonc', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.scss', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini',
  '.cfg', '.csv', '.log', '.py', '.ps1', '.sh', '.sql', '.graphql', '.gql',
]);

const SENSITIVE_SEGMENTS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.desktop-commander-device',
  'appdata\\local\\nativerdc',
  'appdata\\roaming\\microsoft\\credentials',
  'appdata\\local\\microsoft\\credentials',
  'appdata\\local\\google\\chrome\\user data',
  'appdata\\local\\microsoft\\edge\\user data',
  'appdata\\roaming\\mozilla\\firefox\\profiles',
];

const SENSITIVE_BASENAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development',
  'credentials', 'credentials.json', 'secrets.json', 'secrets.yml', 'secrets.yaml',
  'id_rsa', 'id_ed25519', 'known_hosts', 'authorized_keys',
]);

function exactObjectKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function normalizeForCompare(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function rejectPathSyntax(requestedPath: string): void {
  if (!requestedPath || requestedPath.includes('\0')) throw new Error('Remote read path is invalid');
  if (process.platform === 'win32') {
    const raw = requestedPath.replace(/\//g, '\\');
    if (raw.startsWith('\\\\') || raw.startsWith('\\?\\') || raw.startsWith('\\.\\')) {
      throw new Error('UNC and Windows device paths are not permitted for remote reads');
    }
  }
}

function isSensitivePath(realPath: string): boolean {
  const lower = realPath.replace(/\//g, '\\').toLowerCase();
  if (SENSITIVE_SEGMENTS.some((segment) => lower.split('\\').includes(segment)
    || lower.includes('\\' + segment + '\\')
    || lower.endsWith('\\' + segment))) return true;
  const base = path.basename(realPath).toLowerCase();
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (/\.(pem|key|p12|pfx|kdbx)$/i.test(base)) return true;
  return false;
}

async function realReadRoots(readRoots: string[]): Promise<string[]> {
  const unique = new Set<string>();
  for (const root of readRoots.slice(0, 16)) {
    if (typeof root !== 'string' || !root.trim()) continue;
    rejectPathSyntax(root);
    try {
      const real = await fs.realpath(path.resolve(root));
      unique.add(normalizeForCompare(real));
    } catch {
      // A configured root that no longer exists grants nothing.
    }
  }
  return [...unique];
}

export async function authorizeRemoteReadPath(
  requestedPath: string,
  readRoots: string[],
  options: { requireTextFile?: boolean } = {},
): Promise<string> {
  rejectPathSyntax(requestedPath);
  const roots = await realReadRoots(readRoots);
  if (roots.length === 0) throw new Error('No Native RDC read roots are configured');

  let real: string;
  try {
    real = await fs.realpath(path.resolve(requestedPath));
  } catch {
    throw new Error('Remote read target does not exist');
  }
  const comparable = normalizeForCompare(real);
  if (!roots.some((root) => isWithin(root, comparable))) {
    throw new Error('Remote read target is outside approved roots');
  }
  if (isSensitivePath(real)) {
    throw new Error('Remote read target is sensitive and denied');
  }
  if (options.requireTextFile) {
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error('Remote read target must be a regular file');
    const ext = path.extname(real).toLowerCase();
    if (!SAFE_TEXT_EXTENSIONS.has(ext)) throw new Error('Remote read file type is not permitted');
  }
  return real;
}

export async function validateRemoteReadArguments(
  toolName: string,
  args: unknown,
  readRoots: string[],
): Promise<Record<string, unknown>> {
  if (!REMOTE_READ_TOOL_SET.has(toolName)) throw new Error('Remote tool is not permitted');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Remote tool arguments are invalid');
  const input = args as Record<string, unknown>;

  if (toolName === 'get_config' || toolName === 'list_processes') {
    if (Object.keys(input).length !== 0) throw new Error('Remote tool does not accept arguments');
    return {};
  }

  if (typeof input.path !== 'string' || !input.path.trim()) throw new Error('Remote read path is required');

  if (toolName === 'list_directory') {
    if (!exactObjectKeys(input, ['path', 'depth'])) throw new Error('Remote list_directory arguments are invalid');
    const depth = input.depth === undefined ? 1 : input.depth;
    if (!Number.isInteger(depth) || Number(depth) < 1 || Number(depth) > 2) {
      throw new Error('Remote list_directory depth must be 1 or 2');
    }
    return {
      path: await authorizeRemoteReadPath(input.path, readRoots),
      depth: Number(depth),
    };
  }

  if (toolName === 'get_file_info') {
    if (!exactObjectKeys(input, ['path'])) throw new Error('Remote get_file_info arguments are invalid');
    return { path: await authorizeRemoteReadPath(input.path, readRoots) };
  }

  if (toolName === 'read_file') {
    if (!exactObjectKeys(input, ['path', 'offset', 'length'])) throw new Error('Remote read_file arguments are invalid');
    const offset = input.offset === undefined ? 0 : input.offset;
    const length = input.length === undefined ? 200 : input.length;
    if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 100_000) {
      throw new Error('Remote read_file offset is outside the allowed range');
    }
    if (!Number.isInteger(length) || Number(length) < 1 || Number(length) > 200) {
      throw new Error('Remote read_file length must be between 1 and 200');
    }
    return {
      path: await authorizeRemoteReadPath(input.path, readRoots, { requireTextFile: true }),
      offset: Number(offset),
      length: Number(length),
    };
  }

  throw new Error('Remote read tool adapter is not implemented');
}
