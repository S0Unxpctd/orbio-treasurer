import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from './index.js';

describe('core package shell', () => {
  it('exports a semver-looking version', () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
