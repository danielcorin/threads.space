import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import path from 'path';

export default defineConfig({
	plugins: [
		svelte({
			compilerOptions: { runes: true, hmr: false }
		})
	],
	resolve: {
		alias: {
			$lib: path.resolve(import.meta.dirname, 'src/lib')
		}
	},
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}', 'src/**/*.svelte.test.{js,ts}'],
		browser: {
			enabled: true,
			provider: playwright(),
			instances: [{ browser: 'chromium' }]
		}
	}
});
