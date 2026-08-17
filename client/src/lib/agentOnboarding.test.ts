import { describe, expect, it } from 'vitest';
import {
	agentOnboardingSeenKey,
	buildAgentIntegrationPrompt,
	buildAgentIntegrationPrompts,
	resolveAgentIntegrationUrls,
} from './agentOnboarding';

describe('agent onboarding', () => {
	it('builds combined-worker integration URLs from the app origin', () => {
		const urls = resolveAgentIntegrationUrls('https://threads-acme.example.com', '/api');

		expect(urls).toEqual({
			appUrl: 'https://threads-acme.example.com',
			apiBase: 'https://threads-acme.example.com/api',
			agentGuideUrl: 'https://threads-acme.example.com/api/agents.txt',
			apiDocsUrl: 'https://threads-acme.example.com/api/docs',
			openApiUrl: 'https://threads-acme.example.com/api/openapi.json',
			wsEventsUrl: 'https://threads-acme.example.com/api/ws-events.json',
		});
	});

	it('builds a pasteable prompt with hosted docs and credential handling', () => {
		const prompt = buildAgentIntegrationPrompt({
			appUrl: 'https://threads-acme.example.com',
			apiBase: 'https://threads-acme.example.com/api',
			agentGuideUrl: 'https://threads-acme.example.com/api/agents.txt',
			apiDocsUrl: 'https://threads-acme.example.com/api/docs',
			openApiUrl: 'https://threads-acme.example.com/api/openapi.json',
			wsEventsUrl: 'https://threads-acme.example.com/api/ws-events.json',
		});

		expect(prompt).toContain('https://threads-acme.example.com/api/agents.txt');
		expect(prompt).toContain('https://threads-acme.example.com/api/docs');
		expect(prompt).toContain('https://threads-acme.example.com/api/openapi.json');
		expect(prompt).toContain('https://threads-acme.example.com/api/ws-events.json');
		expect(prompt).toContain('Do not store my admin token');
		expect(prompt).toContain('/events');
		expect(prompt).toContain('/processes/cleanup-by-bot');
		expect(prompt).toContain('message_type "response"');
	});

	it('builds generic, Hermes, and OpenClaw prompt variants', () => {
		const prompts = buildAgentIntegrationPrompts({
			appUrl: 'https://threads-acme.example.com',
			apiBase: 'https://threads-acme.example.com/api',
			agentGuideUrl: 'https://threads-acme.example.com/api/agents.txt',
			apiDocsUrl: 'https://threads-acme.example.com/api/docs',
			openApiUrl: 'https://threads-acme.example.com/api/openapi.json',
			wsEventsUrl: 'https://threads-acme.example.com/api/ws-events.json',
		});

		expect(prompts.map((prompt) => prompt.id)).toEqual(['generic', 'hermes', 'openclaw']);
		expect(prompts.find((prompt) => prompt.id === 'hermes')?.prompt).toContain('Hermes platform plugin');
		expect(prompts.find((prompt) => prompt.id === 'hermes')?.prompt).toContain('edit_message');
		expect(prompts.find((prompt) => prompt.id === 'openclaw')?.prompt).toContain('OpenClaw channel plugin');
		expect(prompts.find((prompt) => prompt.id === 'openclaw')?.prompt).toContain('maxTokens');
	});

	it('scopes first-run seen state by version, workspace host, and user', () => {
		expect(agentOnboardingSeenKey('usr_123', 'threads-acme.example.com')).toBe(
			'threads.agentOnboarding.seen.v1.threads-acme.example.com.usr_123',
		);
	});
});
