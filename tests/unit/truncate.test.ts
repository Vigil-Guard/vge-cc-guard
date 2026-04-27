import { describe, it, expect } from 'vitest';
import { truncateText, isBinaryBuffer } from '../../src/daemon/truncate.js';

describe('truncate', () => {
  it('text shorter than 100,000 chars → returned unchanged', () => {
    const text = 'a'.repeat(99_999);
    expect(truncateText(text)).toBe(text);
  });

  it('text exactly 100,000 chars → returned unchanged', () => {
    const text = 'a'.repeat(100_000);
    expect(truncateText(text)).toBe(text);
  });

  it('text 100,001 chars → truncated with marker', () => {
    const text = 'a'.repeat(100_001);
    const result = truncateText(text);
    expect(result).not.toBe(text);
    expect(result).toContain('[truncated middle');
  });

  it('truncated result is STRICTLY LESS THAN 100,000 chars', () => {
    const text = 'a'.repeat(200_000);
    expect(truncateText(text).length).toBeLessThan(100_000);
  });

  it('marker contains the original length', () => {
    const text = 'x'.repeat(150_000);
    expect(truncateText(text)).toContain('150000');
  });

  it('tail of original text appears at end of truncated result', () => {
    const tail = 'TAIL_MARKER';
    const text = 'a'.repeat(100_000) + tail;
    expect(truncateText(text).endsWith(tail)).toBe(true);
  });

  it('head of original text appears at start of truncated result', () => {
    const head = 'HEAD_MARKER';
    const text = head + 'a'.repeat(100_000);
    expect(truncateText(text).startsWith(head)).toBe(true);
  });

  it('PNG magic bytes → isBinaryBuffer returns true', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isBinaryBuffer(buf)).toBe(true);
  });

  it('plain text buffer → isBinaryBuffer returns false', () => {
    const buf = Buffer.from('hello world');
    expect(isBinaryBuffer(buf)).toBe(false);
  });
});
