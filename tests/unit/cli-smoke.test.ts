import { describe, it, expect } from 'vitest';

describe('project scaffold', () => {
  it('package name is correct', async () => {
    const pkg = await import('../../package.json', { with: { type: 'json' } });
    expect(pkg.default.name).toBe('vge-cc-guard');
  });

  it('bin entry points to cli.js', async () => {
    const pkg = await import('../../package.json', { with: { type: 'json' } });
    expect(pkg.default.bin['vge-cc-guard']).toBe('./dist/cli.js');
  });

  it('engines.node constraint matches VGE', async () => {
    const pkg = await import('../../package.json', { with: { type: 'json' } });
    expect(pkg.default.engines.node).toBe('>=24.13.0 <25');
  });
});
