/**
 * useLongPressDrag — shared drag mechanics for sidebar lists.
 *
 * Consolidates the long-press (touch) + mouse-threshold (desktop) drag skeleton
 * used by ChannelList and DMList. The factory owns purely-visual concerns (press
 * timer, drag clone, scroll suppression, synthesized-click suppression). Callers
 * own entity-specific state (what's being dragged, what the drop target is, how
 * to hit-test) via the provided callbacks.
 *
 * Typical usage inside a component:
 *
 *     const drag = createLongPressDrag({
 *       onActivate: (target) => { dragDmId = ... },
 *       onMove: (x, y) => { hitTestDropTarget(x, y); },
 *       onDrop: async () => { await executeDrop(); },
 *       onCleanup: () => { resetDragState(); },
 *     });
 *     // In template:
 *     onmousedown={(e) => drag.onMouseDown(e)}
 *     ontouchstart={(e) => drag.onTouchStart(e)}
 *     ontouchmove={drag.onTouchMove}
 *     ontouchend={drag.onTouchEnd}
 *     ontouchcancel={drag.onTouchCancel}
 */

export interface LongPressDragOptions {
	/**
	 * Fired once drag actually starts (after mouse threshold crossed OR long-press
	 * fired). Caller should record which entity is being dragged and set any
	 * entity-specific state. `target` is the DOM node the drag was initiated from
	 * — it will be cloned for the visual drag preview.
	 */
	onActivate: (target: HTMLElement) => void;

	/**
	 * Fired on every pointer move while dragging. Caller should hit-test under
	 * the pointer and update drop-target state.
	 */
	onMove: (clientX: number, clientY: number) => void;

	/**
	 * Fired when pointer is released while dragging. Caller should execute the
	 * drop based on their tracked state. May be async.
	 */
	onDrop: () => void | Promise<void>;

	/**
	 * Fired always at the end of a drag gesture (after onDrop, or on cancel).
	 * Caller should reset their entity-specific state.
	 */
	onCleanup: () => void;

	/**
	 * Optional: resolve the DOM node to clone from a touchstart event. Defaults
	 * to `e.target`. DMList uses this to walk up to `[data-dm-row]` so the clone
	 * captures the full row rather than a child span.
	 */
	resolveTouchTarget?: (e: TouchEvent) => HTMLElement | null;

	/** Movement threshold (px) before mouse drag arms. Default 5. */
	mouseThreshold?: number;

	/** Movement threshold (px) that cancels an in-flight long-press. Default 10. */
	touchCancelThreshold?: number;

	/** Long-press duration (ms) before touch drag activates. Default 500. */
	longPressMs?: number;

	/** X offset from pointer to clone origin. Default 40. */
	cloneOffsetX?: number;

	/** Y offset from pointer to clone origin. Default 15. */
	cloneOffsetY?: number;
}

export interface LongPressDragController {
	onMouseDown: (e: MouseEvent) => void;
	onTouchStart: (e: TouchEvent) => void;
	onTouchMove: (e: TouchEvent) => void;
	onTouchEnd: () => void | Promise<void>;
	onTouchCancel: () => void | Promise<void>;
	/** True while a drag gesture is active (past activation). */
	readonly isDragging: () => boolean;
}

export function createLongPressDrag(opts: LongPressDragOptions): LongPressDragController {
	const mouseThreshold = opts.mouseThreshold ?? 5;
	const touchCancelThreshold = opts.touchCancelThreshold ?? 10;
	const longPressMs = opts.longPressMs ?? 500;
	const cloneOffsetX = opts.cloneOffsetX ?? 40;
	const cloneOffsetY = opts.cloneOffsetY ?? 15;

	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	let isDragging = false;
	let dragClone: HTMLElement | null = null;
	let pressStartX = 0;
	let pressStartY = 0;
	let preventScrollHandler: ((e: TouchEvent) => void) | null = null;

	// --- Build visual clone and transition into drag mode ---
	function activateDrag(target: HTMLElement) {
		isDragging = true;
		const rect = target.getBoundingClientRect();
		const clone = target.cloneNode(true) as HTMLElement;
		clone.style.position = 'fixed';
		clone.style.left = `${rect.left}px`;
		clone.style.top = `${rect.top}px`;
		clone.style.width = `${rect.width}px`;
		clone.style.opacity = '0.8';
		clone.style.pointerEvents = 'none';
		clone.style.zIndex = '9999';
		document.body.appendChild(clone);
		dragClone = clone;
		opts.onActivate(target);
	}

	// --- Cleanup after drag ends ---
	function cleanupDrag() {
		if (preventScrollHandler) {
			document.removeEventListener('touchmove', preventScrollHandler);
			preventScrollHandler = null;
		}
		if (pressTimer) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}
		if (dragClone) {
			dragClone.remove();
			dragClone = null;
		}
		// Safety net: remove any orphaned clones with z-index 9999
		document.querySelectorAll('body > [style*="z-index: 9999"]').forEach((el) => el.remove());
		// Suppress the synthesized click that browsers fire after touch/pointer sequence
		document.addEventListener(
			'click',
			(e) => {
				e.stopPropagation();
				e.preventDefault();
			},
			{ capture: true, once: true }
		);
		isDragging = false;
		opts.onCleanup();
	}

	// --- Mouse handlers: arm on mousedown, activate after threshold crossed ---
	function onMouseDown(e: MouseEvent) {
		if (e.button !== 0) return;

		// Safety net: clear any orphan clone
		if (dragClone) {
			dragClone.remove();
			dragClone = null;
		}

		pressStartX = e.clientX;
		pressStartY = e.clientY;
		const target = e.currentTarget as HTMLElement;

		const armedMove = (ev: MouseEvent) => {
			const dx = ev.clientX - pressStartX;
			const dy = ev.clientY - pressStartY;
			if (Math.abs(dx) > mouseThreshold || Math.abs(dy) > mouseThreshold) {
				document.removeEventListener('mousemove', armedMove);
				document.removeEventListener('mouseup', armedUp);
				activateDrag(target);
				document.addEventListener('mousemove', onMouseMoveDrag);
				document.addEventListener('mouseup', onMouseUpDrag);
				// Kick off the first hit-test at current position
				onMouseMoveDrag(ev);
			}
		};
		const armedUp = () => {
			document.removeEventListener('mousemove', armedMove);
			document.removeEventListener('mouseup', armedUp);
		};
		document.addEventListener('mousemove', armedMove);
		document.addEventListener('mouseup', armedUp);
	}

	// Invoke caller's onMove with the clone hidden so `elementFromPoint` and
	// friends don't collide with the preview we just put under the cursor.
	function dispatchMove(clientX: number, clientY: number) {
		if (dragClone) dragClone.style.display = 'none';
		try {
			opts.onMove(clientX, clientY);
		} finally {
			if (dragClone) dragClone.style.display = '';
		}
	}

	function onMouseMoveDrag(e: MouseEvent) {
		if (!isDragging || !dragClone) return;
		dragClone.style.left = `${e.clientX - cloneOffsetX}px`;
		dragClone.style.top = `${e.clientY - cloneOffsetY}px`;
		dispatchMove(e.clientX, e.clientY);
	}

	async function onMouseUpDrag() {
		document.removeEventListener('mousemove', onMouseMoveDrag);
		document.removeEventListener('mouseup', onMouseUpDrag);
		if (isDragging) {
			await opts.onDrop();
			cleanupDrag();
		}
	}

	// --- Touch handlers: long-press to activate ---
	function onTouchStart(e: TouchEvent) {
		// Stop propagation so nested list items don't both arm drags
		e.stopPropagation();

		if (pressTimer) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}
		if (dragClone) {
			dragClone.remove();
			dragClone = null;
		}

		const touch = e.touches[0];
		pressStartX = touch.clientX;
		pressStartY = touch.clientY;

		pressTimer = setTimeout(() => {
			const target = opts.resolveTouchTarget
				? opts.resolveTouchTarget(e)
				: (e.target as HTMLElement);
			if (!target) return;
			activateDrag(target);
			// Prevent scroll while dragging — passive:false required for iOS Safari
			preventScrollHandler = (ev: TouchEvent) => ev.preventDefault();
			document.addEventListener('touchmove', preventScrollHandler, { passive: false });
		}, longPressMs);
	}

	function onTouchMove(e: TouchEvent) {
		const touch = e.touches[0];
		// Cancel long-press if finger moved too far before activation
		if (!isDragging && pressTimer) {
			const dx = touch.clientX - pressStartX;
			const dy = touch.clientY - pressStartY;
			if (Math.abs(dx) > touchCancelThreshold || Math.abs(dy) > touchCancelThreshold) {
				clearTimeout(pressTimer);
				pressTimer = null;
			}
			return;
		}
		if (isDragging && dragClone) {
			e.preventDefault();
			dragClone.style.left = `${touch.clientX - cloneOffsetX}px`;
			dragClone.style.top = `${touch.clientY - cloneOffsetY}px`;
			dispatchMove(touch.clientX, touch.clientY);
		}
	}

	async function onTouchEnd() {
		if (pressTimer) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}
		if (isDragging) {
			await opts.onDrop();
			cleanupDrag();
		}
	}

	async function onTouchCancel() {
		if (isDragging) {
			// Attempt drop even on cancel — iOS may cancel touch on scrollable containers
			await opts.onDrop();
		}
		cleanupDrag();
	}

	return {
		onMouseDown,
		onTouchStart,
		onTouchMove,
		onTouchEnd,
		onTouchCancel,
		isDragging: () => isDragging
	};
}
