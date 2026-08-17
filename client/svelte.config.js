import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// Keep SvelteKit's generated Worker out of the repository-owned combined
		// Worker entrypoint. The root Wrangler config deliberately points at
		// worker/combined.ts, so allowing adapter auto-discovery would overwrite
		// that source file on every build.
		adapter: adapter({ config: 'wrangler.svelte.jsonc' })
	},
	vitePlugin: {
		dynamicCompileOptions: ({ filename }) =>
			filename.includes('node_modules') ? undefined : { runes: true }
	}
};

export default config;
