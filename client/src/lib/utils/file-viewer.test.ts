import { describe, expect, test } from 'vitest';
import { detectViewerType } from './file-viewer';

describe('detectViewerType', () => {
	test('audio/* → audio', () => {
		expect(detectViewerType('audio/mpeg', 'song.mp3')).toBe('audio');
		expect(detectViewerType('audio/wav', 'clip.wav')).toBe('audio');
		expect(detectViewerType('audio/ogg', 'voice.ogg')).toBe('audio');
		expect(detectViewerType('audio/webm', 'memo.webm')).toBe('audio');
	});

	test('application/pdf → pdf', () => {
		expect(detectViewerType('application/pdf', 'doc.pdf')).toBe('pdf');
	});

	test('pdf extension → pdf even with octet-stream', () => {
		expect(detectViewerType('application/octet-stream', 'doc.pdf')).toBe('pdf');
	});

	test('text/markdown → markdown', () => {
		expect(detectViewerType('text/markdown', 'README.md')).toBe('markdown');
		expect(detectViewerType('text/x-markdown', 'notes.md')).toBe('markdown');
	});

	test('.md / .markdown extension → markdown', () => {
		expect(detectViewerType('application/octet-stream', 'README.md')).toBe('markdown');
		expect(detectViewerType('text/plain', 'guide.markdown')).toBe('markdown');
	});

	test('text/csv → csv', () => {
		expect(detectViewerType('text/csv', 'data.csv')).toBe('csv');
	});

	test('text/tab-separated-values → csv', () => {
		expect(detectViewerType('text/tab-separated-values', 'data.tsv')).toBe('csv');
	});

	test('.csv / .tsv extension → csv', () => {
		expect(detectViewerType('application/octet-stream', 'sheet.csv')).toBe('csv');
		expect(detectViewerType('application/octet-stream', 'sheet.tsv')).toBe('csv');
	});

	test('application/json → json', () => {
		expect(detectViewerType('application/json', 'data.json')).toBe('json');
	});

	test('+json suffix → json', () => {
		expect(detectViewerType('application/ld+json', 'data.jsonld')).toBe('json');
		expect(detectViewerType('application/vnd.api+json', 'res.json')).toBe('json');
	});

	test('.json / .jsonl / .ndjson extension → json', () => {
		expect(detectViewerType('application/octet-stream', 'config.json')).toBe('json');
		expect(detectViewerType('application/octet-stream', 'records.jsonl')).toBe('json');
		expect(detectViewerType('text/plain', 'records.ndjson')).toBe('json');
	});

	test('text/* → text', () => {
		expect(detectViewerType('text/plain', 'note.txt')).toBe('text');
		expect(detectViewerType('text/css', 'styles.css')).toBe('text');
		expect(detectViewerType('text/html', 'index.html')).toBe('text');
	});

	test('source extensions on octet-stream → text', () => {
		expect(detectViewerType('application/octet-stream', 'index.ts')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'app.tsx')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'main.py')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'lib.rs')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'main.go')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'A.java')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'a.c')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'a.cpp')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'a.h')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'run.sh')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'config.yml')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'config.yaml')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'pyproject.toml')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'setup.ini')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'App.svelte')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'App.vue')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'index.html')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'styles.css')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'styles.scss')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'output.log')).toBe('text');
	});

	test('xml/svg → text', () => {
		expect(detectViewerType('application/xml', 'a.xml')).toBe('text');
		expect(detectViewerType('text/xml', 'a.xml')).toBe('text');
		expect(detectViewerType('application/octet-stream', 'icon.svg')).toBe('text');
	});

	test('unknown binary types → unsupported', () => {
		expect(detectViewerType('application/zip', 'archive.zip')).toBe('unsupported');
		expect(detectViewerType('application/octet-stream', 'mystery.bin')).toBe('unsupported');
		expect(detectViewerType('application/x-7z-compressed', 'a.7z')).toBe('unsupported');
		expect(detectViewerType('application/vnd.ms-excel', 'sheet.xls')).toBe('unsupported');
	});

	test('case-insensitive content type matching', () => {
		expect(detectViewerType('AUDIO/MPEG', 'song.mp3')).toBe('audio');
		expect(detectViewerType('Application/JSON', 'data.json')).toBe('json');
	});

	test('case-insensitive extension matching', () => {
		expect(detectViewerType('application/octet-stream', 'README.MD')).toBe('markdown');
		expect(detectViewerType('application/octet-stream', 'DATA.CSV')).toBe('csv');
		expect(detectViewerType('application/octet-stream', 'SCRIPT.PY')).toBe('text');
	});

	test('empty content type with text extension still resolves', () => {
		expect(detectViewerType('', 'note.md')).toBe('markdown');
		expect(detectViewerType('', 'a.json')).toBe('json');
		expect(detectViewerType('', 'a.txt')).toBe('text');
	});

	test('filename with no extension and unknown type → unsupported', () => {
		expect(detectViewerType('application/octet-stream', 'noext')).toBe('unsupported');
	});
});
