import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/openapi-inventory.test.ts'],
  },
});
