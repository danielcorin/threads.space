import { ui } from '$lib/state/ui.svelte.js';
import { thread } from '$lib/state/thread.svelte.js';
import { blurActiveInput } from '$lib/utils/blur.js';

/**
 * Sets up unified swipe gesture handling for sidebar open/close and thread dismiss.
 * Uses velocity-based detection: a fast flick (>= 0.4 px/ms) snaps in the
 * direction of movement even if displacement is small. Slow drags fall back
 * to the 40%-of-width displacement threshold.
 *
 * Supports both touch (mobile) and mouse click-and-drag (desktop).
 * On desktop (viewport >= 768px) only `close-thread` direction is supported
 * since the sidebar is always visible.
 *
 * Call from onMount and use the returned function as the cleanup callback.
 */
export function setupSwipeGesture(): () => void {
	const EDGE_ZONE = 20; // px from left edge to start open gesture
	const SIDEBAR_WIDTH = 288; // 18rem = 288px, matches CSS
	const SNAP_THRESHOLD = 0.4; // drag past 40% to snap open/closed
	const VELOCITY_THRESHOLD = 0.4; // px/ms -- a brisk flick
	const VELOCITY_SAMPLES = 4; // number of recent touchmove samples to keep
	const MOBILE_BREAKPOINT = 768; // px, matches Tailwind md breakpoint

	let tracking = false;
	let direction: 'open' | 'close' | 'close-thread' | 'close-pins' | 'close-saved-drafts' | 'close-panel' | null = null;
	let startX = 0;
	let startY = 0;
	let committed = false; // whether we've committed to horizontal swipe (vs scroll)
	let mouseTracking = false; // whether a mouse drag is in progress

	// Ring buffer of recent positions for velocity calculation
	let samples: { x: number; t: number }[] = [];

	function recordSample(x: number) {
		samples.push({ x, t: performance.now() });
		if (samples.length > VELOCITY_SAMPLES) {
			samples.shift();
		}
	}

	/** Calculate horizontal velocity in px/ms from recent samples. Positive = rightward. */
	function calcVelocity(): number {
		if (samples.length < 2) return 0;
		const first = samples[0];
		const last = samples[samples.length - 1];
		const dt = last.t - first.t;
		if (dt === 0) return 0;
		return (last.x - first.x) / dt;
	}

	function isMobileViewport(): boolean {
		return window.innerWidth < MOBILE_BREAKPOINT;
	}

	/** Shared start logic for both touch and mouse. Returns true if tracking began. */
	function handleStart(clientX: number, clientY: number): boolean {
		const mobile = isMobileViewport();

		startX = clientX;
		startY = clientY;
		committed = false;
		samples = [];
		recordSample(clientX);

		if (ui.showSavedDraftsPanel && !ui.sidebarOpen) {
			tracking = true;
			direction = 'close-saved-drafts';
		} else if (ui.showPinsPanel && !ui.sidebarOpen) {
			tracking = true;
			direction = 'close-pins';
		} else if (thread.open && !ui.sidebarOpen) {
			tracking = true;
			direction = 'close-thread';
		} else if (mobile && ui.hasOpenPanel && !ui.sidebarOpen) {
			tracking = true;
			direction = 'close-panel';
		} else if (mobile && !ui.sidebarOpen && startX <= EDGE_ZONE) {
			tracking = true;
			direction = 'open';
		} else if (mobile && ui.sidebarOpen) {
			tracking = true;
			direction = 'close';
		}

		return tracking;
	}

	/** Shared move logic for both touch and mouse. */
	function handleMove(clientX: number, clientY: number) {
		if (!tracking || !direction) return;
		const dx = clientX - startX;
		const dy = clientY - startY;

		recordSample(clientX);

		// Wait for enough movement to determine intent
		if (!committed) {
			const absDx = Math.abs(dx);
			const absDy = Math.abs(dy);
			if (absDx < 10 && absDy < 10) return;
			// If vertical movement dominates, this is a scroll -- bail out
			if (absDy > absDx) {
				tracking = false;
				direction = null;
				ui.setSidebarDragOffset(null);
				return;
			}
			committed = true;
			// Dismiss the virtual keyboard as soon as a horizontal sidebar/panel
			// swipe commits — navigation gestures shouldn't leave the keyboard up.
			if (direction === 'open' || direction === 'close') {
				blurActiveInput();
			}
		}

		if (direction === 'close-thread') {
			const offset = Math.max(0, dx);
			ui.setThreadDragOffset(offset);
			return;
		} else if (direction === 'close-saved-drafts') {
			const offset = Math.max(0, dx);
			ui.setSavedDraftsDragOffset(offset);
			return;
		} else if (direction === 'close-pins') {
			const offset = Math.max(0, dx);
			ui.setPinsDragOffset(offset);
			return;
		} else if (direction === 'close-panel') {
			const offset = Math.max(0, dx);
			ui.setPanelDragOffset(offset);
			return;
		} else if (direction === 'open') {
			const progress = Math.max(0, Math.min(1, dx / SIDEBAR_WIDTH));
			ui.setSidebarDragOffset(progress);
		} else {
			// Closing: dx is negative when swiping left
			const progress = Math.max(0, Math.min(1, 1 + dx / SIDEBAR_WIDTH));
			ui.setSidebarDragOffset(progress);
		}
	}

	/** Shared end logic for both touch and mouse. */
	function handleEnd() {
		if (!tracking || !direction) return;

		// If the gesture never committed to a horizontal swipe (just a tap or
		// vertical scroll), don't treat it as a swipe — let the tap through.
		if (!committed) {
			tracking = false;
			direction = null;
			ui.setSidebarDragOffset(null);
			ui.setThreadDragOffset(null);
			ui.setPinsDragOffset(null);
			ui.setSavedDraftsDragOffset(null);
			ui.setPanelDragOffset(null);
			return;
		}

		const velocity = calcVelocity(); // px/ms, positive = rightward

		if (direction === 'close-thread') {
			const dragPx = ui.threadDragOffset ?? 0;
			const screenWidth = window.innerWidth;
			const flick = velocity >= VELOCITY_THRESHOLD;
			const pastThreshold = committed && dragPx > screenWidth * SNAP_THRESHOLD;

			ui.setThreadDragAnimating(true);
			if (flick || pastThreshold) {
				ui.setThreadDragOffset(screenWidth);
				setTimeout(() => {
					thread.close();
					ui.setThreadDragOffset(null);
					ui.setThreadDragAnimating(false);
				}, 200);
			} else {
				ui.setThreadDragOffset(0);
				setTimeout(() => {
					ui.setThreadDragOffset(null);
					ui.setThreadDragAnimating(false);
				}, 200);
			}
			tracking = false;
			direction = null;
			return;
		}

		if (direction === 'close-pins') {
			const dragPx = ui.pinsDragOffset ?? 0;
			const screenWidth = window.innerWidth;
			const flick = velocity >= VELOCITY_THRESHOLD;
			const pastThreshold = committed && dragPx > screenWidth * SNAP_THRESHOLD;

			ui.setPinsDragAnimating(true);
			if (flick || pastThreshold) {
				ui.setPinsDragOffset(screenWidth);
				setTimeout(() => {
					ui.closePinsPanel();
					ui.setPinsDragOffset(null);
					ui.setPinsDragAnimating(false);
				}, 200);
			} else {
				ui.setPinsDragOffset(0);
				setTimeout(() => {
					ui.setPinsDragOffset(null);
					ui.setPinsDragAnimating(false);
				}, 200);
			}
			tracking = false;
			direction = null;
			return;
		}

		if (direction === 'close-saved-drafts') {
			const dragPx = ui.savedDraftsDragOffset ?? 0;
			const screenWidth = window.innerWidth;
			const flick = velocity >= VELOCITY_THRESHOLD;
			const pastThreshold = committed && dragPx > screenWidth * SNAP_THRESHOLD;

			ui.setSavedDraftsDragAnimating(true);
			if (flick || pastThreshold) {
				ui.setSavedDraftsDragOffset(screenWidth);
				setTimeout(() => {
					ui.closeSavedDraftsPanel();
					ui.setSavedDraftsDragOffset(null);
					ui.setSavedDraftsDragAnimating(false);
				}, 200);
			} else {
				ui.setSavedDraftsDragOffset(0);
				setTimeout(() => {
					ui.setSavedDraftsDragOffset(null);
					ui.setSavedDraftsDragAnimating(false);
				}, 200);
			}
			tracking = false;
			direction = null;
			return;
		}

		if (direction === 'close-panel') {
			const dragPx = ui.panelDragOffset ?? 0;
			const screenWidth = window.innerWidth;
			const flick = velocity >= VELOCITY_THRESHOLD;
			const pastThreshold = committed && dragPx > screenWidth * SNAP_THRESHOLD;

			ui.setPanelDragAnimating(true);
			if (flick || pastThreshold) {
				ui.setPanelDragOffset(screenWidth);
				setTimeout(() => {
					ui.closeCurrentPanel();
				}, 200);
			} else {
				ui.setPanelDragOffset(0);
				setTimeout(() => {
					ui.setPanelDragOffset(null);
					ui.setPanelDragAnimating(false);
				}, 200);
			}
			tracking = false;
			direction = null;
			return;
		}

		const offset = ui.sidebarDragOffset ?? 0;
		// Animate the sidebar to its final position after release
		ui.setSidebarDragAnimating(true);

		if (direction === 'open') {
			// Rightward flick opens, leftward flick closes
			const flickOpen = velocity >= VELOCITY_THRESHOLD;
			const flickClose = velocity <= -VELOCITY_THRESHOLD;
			if (flickOpen || (!flickClose && offset >= SNAP_THRESHOLD)) {
				ui.setSidebarDragOffset(1);
				setTimeout(() => {
					ui.openSidebar();
				}, 300);
			} else {
				ui.setSidebarDragOffset(0);
				setTimeout(() => {
					ui.closeSidebar();
				}, 300);
			}
		} else {
			// direction === 'close'
			// Leftward flick closes, rightward flick keeps open
			const flickClose = velocity <= -VELOCITY_THRESHOLD;
			const flickOpen = velocity >= VELOCITY_THRESHOLD;
			if (flickClose || (!flickOpen && offset <= 1 - SNAP_THRESHOLD)) {
				ui.setSidebarDragOffset(0);
				setTimeout(() => {
					ui.closeSidebar();
				}, 300);
			} else {
				ui.setSidebarDragOffset(1);
				setTimeout(() => {
					ui.openSidebar();
				}, 300);
			}
		}

		tracking = false;
		direction = null;
	}

	// --- Touch handlers ---

	function onTouchStart(e: TouchEvent) {
		const touch = e.touches[0];
		handleStart(touch.clientX, touch.clientY);
	}

	function onTouchMove(e: TouchEvent) {
		const touch = e.touches[0];
		handleMove(touch.clientX, touch.clientY);
	}

	function onTouchEnd() {
		handleEnd();
	}

	// --- Mouse handlers ---

	function onMouseDown(e: MouseEvent) {
		// Only track primary button (left click)
		if (e.button !== 0) return;
		if (handleStart(e.clientX, e.clientY)) {
			mouseTracking = true;
		}
	}

	function onMouseMove(e: MouseEvent) {
		if (!mouseTracking) return;
		// Prevent text selection during drag
		if (committed) {
			e.preventDefault();
		}
		handleMove(e.clientX, e.clientY);
	}

	function onMouseUp() {
		if (!mouseTracking) return;
		mouseTracking = false;
		handleEnd();
	}

	// --- Register listeners ---

	document.addEventListener('touchstart', onTouchStart, { passive: true });
	document.addEventListener('touchmove', onTouchMove, { passive: true });
	document.addEventListener('touchend', onTouchEnd, { passive: true });

	document.addEventListener('mousedown', onMouseDown);
	document.addEventListener('mousemove', onMouseMove);
	document.addEventListener('mouseup', onMouseUp);

	return () => {
		document.removeEventListener('touchstart', onTouchStart);
		document.removeEventListener('touchmove', onTouchMove);
		document.removeEventListener('touchend', onTouchEnd);
		document.removeEventListener('mousedown', onMouseDown);
		document.removeEventListener('mousemove', onMouseMove);
		document.removeEventListener('mouseup', onMouseUp);
	};
}
