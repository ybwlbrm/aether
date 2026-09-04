import { describe, it, expect } from 'vitest';
import { cn } from './utils';

describe('utils', () => {
  it('cn should merge class names', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('cn should handle conditional classes', () => {
    expect(cn('a', false && 'b', 'c')).toBe('a c');
  });

  it('cn should handle tailwind class conflicts', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });
});