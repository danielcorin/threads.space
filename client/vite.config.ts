import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
// Node built-in, used only at build time (Cloudflare adapter ships no Node types).
import { execSync } from 'node:child_process';

function resolveCommitSha(): string {
	const configured = process.env.GITHUB_SHA ?? process.env.CF_PAGES_COMMIT_SHA;
	if (configured) return configured.slice(0, 7);
	try {
		return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
	} catch {
		return 'dev';
	}
}

const commitSha = resolveCommitSha();
// Optional: base URL of the source repo, used to link the commit SHA in the UI.
// e.g. "https://github.com/org/repo". Empty by default — the SHA shows as plain text.
const repoUrl = process.env.PUBLIC_REPO_URL ?? '';

export default defineConfig({
	define: {
		__COMMIT_SHA__: JSON.stringify(commitSha),
		__REPO_URL__: JSON.stringify(repoUrl)
	},
	plugins: [tailwindcss(), sveltekit()],
	build: {
		// Threads intentionally ships as a single app shell; keep the warning
		// threshold aligned with the current bundle size so build output stays clean.
		chunkSizeWarningLimit: 700
	},
	server: {
		host: '127.0.0.1',
		port: 5173,
		proxy: {
			'/api': {
				target: 'http://127.0.0.1:8788',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api/, '')
			},
			'/ws': {
				target: 'ws://127.0.0.1:8788',
				ws: true
			}
		}
	}
});
