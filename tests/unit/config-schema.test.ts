import { describe, it, expect } from 'vitest';
import { configSchema, DEFAULT_CONFIG } from '../../src/shared/config-schema.js';

describe('config-schema', () => {
  it('DEFAULT_CONFIG passes validation — empty api_key_input is allowed at schema level', () => {
    expect(() => configSchema.parse(DEFAULT_CONFIG)).not.toThrow();
  });

  it('accepts valid live API key', () => {
    const c = { ...DEFAULT_CONFIG, vge: { ...DEFAULT_CONFIG.vge, api_key_input: 'vg_live_abc123' } };
    expect(() => configSchema.parse(c)).not.toThrow();
  });

  it('accepts valid test API key', () => {
    const c = { ...DEFAULT_CONFIG, vge: { ...DEFAULT_CONFIG.vge, api_key_input: 'vg_test_xyz789' } };
    expect(() => configSchema.parse(c)).not.toThrow();
  });

  it('wildcard * tool entry is valid', () => {
    const result = configSchema.parse(DEFAULT_CONFIG);
    expect(result.tools['*']).toEqual({ gate: 'ask', analyze_output: false });
  });

  it('rejects version other than 1.0.0', () => {
    expect(() => configSchema.parse({ ...DEFAULT_CONFIG, version: '2.0.0' })).toThrow();
    expect(() => configSchema.parse({ ...DEFAULT_CONFIG, version: '1.0' })).toThrow();
  });

  it('rejects unknown gate values', () => {
    const bad = { ...DEFAULT_CONFIG, tools: { Bash: { gate: 'maybe', analyze_output: true } } };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it('rejects non-boolean analyze_output', () => {
    const bad = { ...DEFAULT_CONFIG, tools: { Bash: { gate: 'allow', analyze_output: 'yes' } } };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it('rejects fatigue_cap_per_session = 0 (below min 1)', () => {
    const bad = { ...DEFAULT_CONFIG, policy: { ...DEFAULT_CONFIG.policy, fatigue_cap_per_session: 0 } };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it('rejects fatigue_cap_per_session = 21 (above max 20)', () => {
    const bad = { ...DEFAULT_CONFIG, policy: { ...DEFAULT_CONFIG.policy, fatigue_cap_per_session: 21 } };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it('rejects non-URL api_url', () => {
    const bad = { ...DEFAULT_CONFIG, vge: { ...DEFAULT_CONFIG.vge, api_url: 'not-a-url' } };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it('rejects null api_key_input (must be string, even empty)', () => {
    const bad = { ...DEFAULT_CONFIG, vge: { ...DEFAULT_CONFIG.vge, api_key_input: null } };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it('DEFAULT_CONFIG has all 10 tool entries', () => {
    expect(Object.keys(DEFAULT_CONFIG.tools)).toHaveLength(10);
  });

  it('Write and Edit default to gate: block', () => {
    expect(DEFAULT_CONFIG.tools['Write'].gate).toBe('block');
    expect(DEFAULT_CONFIG.tools['Edit'].gate).toBe('block');
  });

  it('api_key_output defaults to null', () => {
    expect(DEFAULT_CONFIG.vge.api_key_output).toBeNull();
  });

  it('credential_protection defaults to true', () => {
    expect(DEFAULT_CONFIG.policy.credential_protection).toBe(true);
  });
});
