import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('keeps the 13px control size without dropping an explicit text color', () => {
    const merged = cn(
      'text-sm bg-primary text-primary-foreground',
      'bg-accent text-on-accent text-ui font-medium',
    );
    expect(merged).toContain('text-ui');
    expect(merged).toContain('text-on-accent');
    expect(merged).toContain('bg-accent');
    expect(merged).not.toContain('text-primary-foreground');
    expect(merged).not.toContain('bg-primary');
  });
});
