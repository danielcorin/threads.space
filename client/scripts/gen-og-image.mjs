// Regenerates static/og-image.png — a 1200x630 social card for Threads.
// Run with: node scripts/gen-og-image.mjs
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, '../static/og-image.png');

const W = 1200;
const H = 630;
const TITLE = 'Threads';
const SUBTITLE = 'Threaded chat for humans & AI agents';

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const HUMAN = '#7c8cff'; // indigo accent — human messages
const BOT = '#34d6c2'; // teal accent — bot / agent messages

// A chat bubble: rounded rect with a small avatar dot and two "text" lines.
// `accent` tints the avatar + border so human vs. agent reads at a glance.
function bubble(x, y, w, accent, opacity = 1) {
	const h = 62;
	const r = 16;
	const lineW = w - 78;
	return `
	<g opacity="${opacity}">
		<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}"
			fill="#222441" stroke="${accent}" stroke-opacity="0.55" stroke-width="1.5" />
		<circle cx="${x + 31}" cy="${y + h / 2}" r="13" fill="${accent}" fill-opacity="0.9" />
		<rect x="${x + 54}" y="${y + 19}" width="${lineW}" height="7" rx="3.5" fill="#5b6189" />
		<rect x="${x + 54}" y="${y + 35}" width="${lineW * 0.62}" height="7" rx="3.5" fill="#3f456e" />
	</g>`;
}

// An elbow connector (vertical drop + rounded corner into a horizontal run)
// linking a parent bubble to an indented reply — the visual grammar of a thread.
function connector(x, fromY, toY, run, accent) {
	return `<path d="M ${x} ${fromY} L ${x} ${toY - 16} Q ${x} ${toY} ${x + 16} ${toY} L ${x + run} ${toY}"
		fill="none" stroke="${accent}" stroke-opacity="0.5" stroke-width="2" stroke-linecap="round" />`;
}

// A threaded conversation: a root message with two nested replies (human ↔ agent),
// the product's core idea rendered as the card's hero motif.
const rootX = 120, rootY = 150, rootW = 470;
const reply1X = 196, reply1Y = 250, reply1W = 432;
const reply2X = 272, reply2Y = 350, reply2W = 394;
const thread = `
	${connector(rootX + 24, rootY + 62, reply1Y + 31, reply1X - rootX - 24, HUMAN)}
	${connector(reply1X + 24, reply1Y + 62, reply2Y + 31, reply2X - reply1X - 24, BOT)}
	${bubble(rootX, rootY, rootW, HUMAN)}
	${bubble(reply1X, reply1Y, reply1W, BOT)}
	${bubble(reply2X, reply2Y, reply2W, HUMAN)}
`;

// Faint, deterministic background bubbles for depth (no RNG → reproducible).
const ghosts = [
	[820, 96, 300, HUMAN, 0.1],
	[880, 470, 240, BOT, 0.1],
	[40, 470, 200, BOT, 0.08]
].map(([x, y, w, a, o]) => bubble(x, y, w, a, o)).join('');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="#191a2e" />
			<stop offset="0.5" stop-color="#1c1d33" />
			<stop offset="1" stop-color="#15162a" />
		</linearGradient>
	</defs>
	<rect width="${W}" height="${H}" fill="url(#bg)" />
	${ghosts}
	${thread}
	<text x="${W - 90}" y="498" text-anchor="end"
		font-family="${FONT}" font-size="118" font-weight="600" fill="#e6e6ef"
		letter-spacing="-2">${TITLE}</text>
	<text x="${W - 90}" y="548" text-anchor="end"
		font-family="${FONT}" font-size="30" font-weight="400" fill="#7a80a8">${SUBTITLE}</text>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent(
	`<!doctype html><html><body style="margin:0">${svg}</body></html>`,
	{ waitUntil: 'networkidle' }
);
await page.locator('svg').screenshot({ path: out });
await browser.close();
console.log('wrote', out);
