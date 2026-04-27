import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkPath } from '../../src/daemon/path-deny.js';

describe('path-deny', () => {
  const home = os.homedir();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vge-deny-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('~/.aws/credentials → denied', () => {
    expect(checkPath('~/.aws/credentials').denied).toBe(true);
  });

  it('~/.ssh/id_rsa → denied', () => {
    expect(checkPath('~/.ssh/id_rsa').denied).toBe(true);
  });

  it('~/.ssh/id_rsa.pub → denied (basename match: id_rsa*)', () => {
    expect(checkPath('~/.ssh/id_rsa.pub').denied).toBe(true);
  });

  it('/tmp/.env → denied', () => {
    expect(checkPath('/tmp/.env').denied).toBe(true);
  });

  it('/home/user/project/.env → denied', () => {
    expect(checkPath('/home/user/project/.env').denied).toBe(true);
  });

  it('~/project/src/main.ts → NOT denied', () => {
    expect(checkPath('~/project/src/main.ts').denied).toBe(false);
  });

  it('~/project/config.json → NOT denied', () => {
    expect(checkPath('~/project/config.json').denied).toBe(false);
  });

  it('path with .. that resolves to a denied path → denied', () => {
    // ~/project/../.aws/credentials resolves to ~/.aws/credentials
    expect(checkPath(`${home}/project/../.aws/credentials`).denied).toBe(true);
  });

  it('non-existent path matching a pattern → denied (resolution falls back to pre-realpath)', () => {
    // This file doesn't exist but matches the .env pattern
    expect(checkPath('/nonexistent/path/.env').denied).toBe(true);
  });

  it('symlink pointing to ~/.aws/credentials → denied (realpathSync resolves it)', () => {
    const awsCreds = path.join(home, '.aws', 'credentials');
    const symlinkPath = path.join(tmpDir, 'mylink');
    // Create the symlink regardless of whether the target exists
    // realpathSync should resolve the target path
    try {
      fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
      if (!fs.existsSync(awsCreds)) {
        fs.writeFileSync(awsCreds, '');
      }
      fs.symlinkSync(awsCreds, symlinkPath);
      expect(checkPath(symlinkPath).denied).toBe(true);
    } catch {
      // If we can't create the real file, test the symlink to a non-existent target
      // realpathSync will fall back to the symlink target path which still matches
      try {
        fs.symlinkSync(awsCreds, symlinkPath);
      } catch {
        // symlink may already exist
      }
      expect(checkPath(symlinkPath).denied).toBe(true);
    }
  });

  it('id_ed25519 → denied (basename match)', () => {
    expect(checkPath(`${home}/.ssh/id_ed25519`).denied).toBe(true);
  });

  it('~/.kube/config → denied', () => {
    expect(checkPath('~/.kube/config').denied).toBe(true);
  });

  it('/project/mysecrets.json → denied (basename *secrets*)', () => {
    expect(checkPath('/project/mysecrets.json').denied).toBe(true);
  });

  it('/project/my_credentials_backup.json → denied (basename *credentials*)', () => {
    expect(checkPath('/project/my_credentials_backup.json').denied).toBe(true);
  });

  it('resolvedPath is returned for non-denied paths', () => {
    const result = checkPath('~/project/src/main.ts');
    expect(result.denied).toBe(false);
    expect(result.resolvedPath).toBeTruthy();
    expect(path.isAbsolute(result.resolvedPath)).toBe(true);
  });
});
