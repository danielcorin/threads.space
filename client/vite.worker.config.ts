import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [cloudflare({ configPath: '../wrangler.jsonc' })],
	build: {
		emptyOutDir: true,
		rollupOptions: {
			external: ['cloudflare:workers'],
			preserveEntrySignatures: 'exports-only'
		}
	}
});
