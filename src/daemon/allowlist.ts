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
  if (obj === null || typeof obj !== 'object') return {};
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE_KEYS.has(k)));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const sorted = Object.keys(value as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return '{' + sorted.join(',') + '}';
}

// Stable fallback key when expected fields are missing or malformed.
// PR-review W4: canonicalizeKey must never throw — combined with C2's fail-closed
// shim, throws here would silently turn into pretool fail-open via Express 500.
function malformedKey(toolName: string, toolInput: Record<string, unknown>): string {
  const safeName = typeof toolName === 'string' && toolName.length > 0 ? toolName : 'unknown';
  const safeInput = toolInput && typeof toolInput === 'object' ? toolInput : {};
  return `${safeName}:malformed:${sha256(stableStringify(stripVolatileFields(safeInput))).slice(0, 12)}`;
}

export function canonicalizeKey(toolName: string, toolInput: Record<string, unknown>): string {
  try {
    switch (toolName) {
      case 'WebFetch': {
        const raw = toolInput['url'];
        if (typeof raw !== 'string') return malformedKey(toolName, toolInput);
        const u = new URL(raw);
        u.hash = '';
        // TODO Phase 1c: strip tracking params (utm_*, fbclid, ref)
        return `WebFetch:${u.href}`;
      }
      case 'WebSearch': {
        const q = toolInput['query'];
        if (typeof q !== 'string') return malformedKey(toolName, toolInput);
        return `WebSearch:${q}`;
      }
      case 'Read': {
        const fp = toolInput['file_path'];
        if (typeof fp !== 'string') return malformedKey(toolName, toolInput);
        return `Read:${path.resolve(expandTilde(fp))}`;
      }
      case 'Glob': {
        const pattern = toolInput['pattern'];
        if (typeof pattern !== 'string') return malformedKey(toolName, toolInput);
        const cwd = (toolInput['cwd'] as string | undefined) ?? process.cwd();
        return `${pattern}:${path.resolve(cwd)}`;
      }
      case 'Grep': {
        const pattern = toolInput['pattern'];
        if (typeof pattern !== 'string') return malformedKey(toolName, toolInput);
        const p = (toolInput['path'] as string | undefined) ?? process.cwd();
        return `${pattern}:${path.resolve(p)}`;
      }
      case 'Bash': {
        const cmd = toolInput['command'];
        if (typeof cmd !== 'string') return malformedKey(toolName, toolInput);
        return `bash:${sha256(normalizeWhitespace(cmd.toLowerCase())).slice(0, 12)}`;
      }
      case 'Edit': {
        const fp = toolInput['file_path'];
        const old = toolInput['old_string'];
        if (typeof fp !== 'string' || typeof old !== 'string') return malformedKey(toolName, toolInput);
        return `${path.resolve(fp)}:edit:${sha256(old).slice(0, 12)}`;
      }
      case 'Write': {
        const fp = toolInput['file_path'];
        const content = toolInput['content'];
        if (typeof fp !== 'string' || typeof content !== 'string') return malformedKey(toolName, toolInput);
        return `${path.resolve(fp)}:write:${sha256(content).slice(0, 12)}`;
      }
      case 'Task': {
        const prompt = toolInput['prompt'];
        if (typeof prompt !== 'string') return malformedKey(toolName, toolInput);
        const sub = (toolInput['subagent_type'] as string | undefined) ?? 'unknown';
        return `task:${sub}:${sha256(prompt).slice(0, 12)}`;
      }
      default:
        return `${toolName}:${sha256(stableStringify(stripVolatileFields(toolInput ?? {}))).slice(0, 12)}`;
    }
  } catch {
    return malformedKey(toolName, toolInput);
  }
}
