import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2026-05-01',
        d1Databases: ['DB'],
        durableObjects: {
          CHAT_ROOM: 'ChatRoom',
          PRESENCE_ROOM: 'PresenceRoom',
          USER_EVENTS_ROOM: 'UserEventsRoom',
        },
        r2Buckets: ['UPLOADS'],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, 'migrations')),
          ENVIRONMENT: 'development',
          VAPID_PUBLIC_KEY: 'test',
          VAPID_PRIVATE_KEY: 'test',
          VAPID_SUBJECT: 'mailto:test@example.com',
          WEBHOOK_ALLOW_INSECURE_URLS: 'false',
          MFA_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
        },
      },
    })),
  ],
  test: {
    include: ['src/service-tests/*.service.test.ts'],
    setupFiles: ['src/service-tests/apply-migrations.ts'],
  },
});
