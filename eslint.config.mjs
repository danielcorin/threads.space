import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import svelteConfig from './client/svelte.config.js';

export default ts.config(
	// Paths that should never be linted (generated, build output, deps).
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/build/**',
			'**/.wrangler/**',
			'examples/agent-containers/**',
			'client/.svelte-kit/**',
			'api/generated/**',
			'**/*.d.ts'
		]
	},

	// Base JS + TypeScript recommended rules.
	js.configs.recommended,
	...ts.configs.recommended,

	// Svelte recommended rules.
	...svelte.configs.recommended,

	// Shared globals: browser (client), node/worker (api, cli).
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				...globals.worker
			}
		},
		rules: {
			// Allow intentionally-unused identifiers when prefixed with `_`.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_'
				}
			],
			// Numerous pre-existing `any`s; surface as warnings rather than
			// blocking commits, since blind retyping risks regressions.
			'@typescript-eslint/no-explicit-any': 'warn',
			// Switching native Map/Set/URL to Svelte reactive variants is a
			// behavioral change; flag it without blocking commits.
			'svelte/prefer-svelte-reactivity': 'warn',
			// Empty catch blocks are an intentional "ignore this error" idiom.
			'no-empty': ['error', { allowEmptyCatch: true }],
			// `cond && fn()` / `cond ? a() : b()` are intentional call idioms.
			'@typescript-eslint/no-unused-expressions': [
				'error',
				{ allowShortCircuit: true, allowTernary: true }
			],
			// Most <a href> targets here are external (user content, downloads,
			// repo links); only programmatic goto() benefits from resolve().
			'svelte/no-navigation-without-resolve': ['error', { ignoreLinks: true }],
			// The Svelte compiler (svelte-check, run in precommit) is the
			// authority on whether a `svelte-ignore` directive is needed; this
			// rule's a11y analysis diverges from it and produces false positives.
			'svelte/no-unused-svelte-ignore': 'off'
		}
	},

	// TypeScript/Svelte handle undefined references themselves; the core
	// no-undef rule false-positives on DOM types and build-time globals.
	{
		files: ['**/*.ts', '**/*.svelte', '**/*.svelte.ts'],
		rules: {
			'no-undef': 'off'
		}
	},

	// Service worker runs in its own global scope.
	{
		files: ['**/sw.js', '**/service-worker.js'],
		languageOptions: {
			globals: globals.serviceworker
		}
	},

	// Wire the TypeScript parser into <script lang="ts"> blocks.
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				svelteConfig
			}
		}
	},

	// Test files: relax rules that fight common test idioms.
	{
		files: ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off'
		}
	}
);
