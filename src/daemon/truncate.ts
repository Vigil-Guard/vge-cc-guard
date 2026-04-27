const MAX_CHARS = 100_000;
// HALF * 2 + marker (~45 chars) < MAX_CHARS: 49_975*2 + 45 = 99_995
const HALF = 49_975;

const BINARY_MAGIC_BYTES: readonly number[][] = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x25, 0x50, 0x44, 0x46], // PDF
  [0x50, 0x4b, 0x03, 0x04], // ZIP
  [0xff, 0xd8, 0xff],       // JPEG
  [0x47, 0x49, 0x46],       // GIF
];

export function truncateText(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const head = text.slice(0, HALF);
  const tail = text.slice(text.length - HALF);
  const marker = `\n[truncated middle, original was ${text.length} chars]\n`;
  return head + marker + tail;
}

export function isBinaryBuffer(buf: Buffer): boolean {
  return BINARY_MAGIC_BYTES.some((magic) => magic.every((byte, i) => buf[i] === byte));
}
