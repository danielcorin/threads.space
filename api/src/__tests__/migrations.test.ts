import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { resolve } from 'path';

describe('migrations directory hygiene', () => {
  const files = readdirSync(resolve(__dirname, '../../migrations')).filter((f) =>
    f.endsWith('.sql'),
  );

  it('every migration is named NNNN_description.sql', () => {
    for (const file of files) {
      expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  it('has no duplicate numeric prefixes', () => {
    const counts = new Map<string, string[]>();
    for (const file of files) {
      const prefix = file.slice(0, 4);
      counts.set(prefix, [...(counts.get(prefix) ?? []), file]);
    }
    const duplicates = [...counts.entries()].filter(([, names]) => names.length > 1);
    expect(
      duplicates,
      `Duplicate migration prefixes found: ${duplicates
        .map(([, names]) => names.join(' / '))
        .join(', ')}. ` +
        'Use `npx wrangler d1 migrations create threads <name>` to auto-number new migrations.',
    ).toEqual([]);
  });
});
