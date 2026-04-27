import * as crypto from 'crypto';
import * as path from 'path';
import { expandTilde } from './path-deny.js';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const VOLATILE_KEYS = new Set(['timestamp', 'requestId', 'sessionId', 'traceId', 'id']);

function stripVolatileFields(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE_KEYS.has(k)));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const sorted = Object.keys(value as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return '{' + sorted.join(',') + '}';
}

export function canonicalizeKey(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'WebFetch': {
      const raw = toolInput['url'] as string;
      const u = new URL(raw);
      u.hash = '';
      // TODO Phase 1c: strip tracking params (utm_*, fbclid, ref)
      return `WebFetch:${u.href}`;
    }
    case 'WebSearch':
      return `WebSearch:${toolInput['query'] as string}`;
    case 'Read':
      return `Read:${path.resolve(expandTilde(toolInput['file_path'] as string))}`;
    case 'Glob':
      return `${toolInput['pattern'] as string}:${path.resolve((toolInput['cwd'] as string | undefined) ?? process.cwd())}`;
    case 'Grep':
      return `${toolInput['pattern'] as string}:${path.resolve((toolInput['path'] as string | undefined) ?? process.cwd())}`;
    case 'Bash':
      return `bash:${sha256(normalizeWhitespace((toolInput['command'] as string).toLowerCase())).slice(0, 12)}`;
    case 'Edit':
      return `${path.resolve(toolInput['file_path'] as string)}:edit:${sha256(toolInput['old_string'] as string).slice(0, 12)}`;
    case 'Write':
      return `${path.resolve(toolInput['file_path'] as string)}:write:${sha256(toolInput['content'] as string).slice(0, 12)}`;
    case 'Task':
      return `task:${(toolInput['subagent_type'] as string | undefined) ?? 'unknown'}:${sha256(toolInput['prompt'] as string).slice(0, 12)}`;
    default:
      return `${toolName}:${sha256(stableStringify(stripVolatileFields(toolInput))).slice(0, 12)}`;
  }
}
