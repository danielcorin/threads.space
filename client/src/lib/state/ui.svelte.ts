export type AppView = 'channels' | 'inbox' | 'processes';
export type ConversationMode = 'timeline' | 'tasks';

const CONVERSATION_MODE_STORAGE_KEY = 'threads.conversation.mode';
const TASK_AUTHOR_FILTERS_STORAGE_KEY = 'threads.tasks.author-filters';

let _sidebarOpen = $state(false);
let _currentView = $state<AppView>('channels');
let _conversationMode = $state<ConversationMode>('timeline');
let _taskAuthorFilters = $state<Record<string, string[]>>({});
let _windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);

// Viewport height that accounts for the virtual keyboard on iOS.
// null means "use CSS 100dvh"; a pixel value means the keyboard is open (or we're
// on a platform where dvh doesn't track the keyboard) and we need an explicit height.
let _viewportHeight = $state<number | null>(null);

// Interactive drag state for swipe gesture.
// dragOffset is 0 (fully closed) to 1 (fully open), or null when not dragging.
let _sidebarDragOffset = $state<number | null>(null);

// Thread panel drag offset in pixels (0 = resting, positive = dragged right).
// null when not actively dragging.
let _threadDragOffset = $state<number | null>(null);
// True when the thread panel is animating to its final position after release.
let _threadDragAnimating = $state(false);
// Active inline widget panel (null = none shown)
let _activeWidgetId = $state<string | null>(null);
// Active right-side split widget panel (null = none shown)
let _splitWidgetId = $state<string | null>(null);
// Board panel visibility
let _showBoardPanel = $state(false);
// Pins panel visibility
let _showPinsPanel = $state(false);
// Pins panel drag offset in pixels (0 = resting, positive = dragged right).
let _pinsDragOffset = $state<number | null>(null);
let _pinsDragAnimating = $state(false);
// Debug panel visibility
let _showDebugPanel = $state(false);
// Saved drafts panel visibility
let _showSavedDraftsPanel = $state(false);
// Saved drafts panel drag offset in pixels (0 = resting, positive = dragged right).
let _savedDraftsDragOffset = $state<number | null>(null);
let _savedDraftsDragAnimating = $state(false);
// True when the sidebar is animating to its final position after drag release.
let _sidebarDragAnimating = $state(false);

// Panel (widget/board) drag offset in pixels for swipe-to-dismiss.
// null when not actively dragging.
let _panelDragOffset = $state<number | null>(null);
// True when the panel is animating to its final position after release.
let _panelDragAnimating = $state(false);

// --- Mobile viewport diagnostic state (debug overlay only) ---
// Enabled via localStorage key `threads.debug.vv` = `1`.
// Purpose: after two failed keyboard-fix attempts, capture live iOS VV numbers
// from the device to diagnose why the shell jumps off-screen.
let _debugMobile = $state(false);
let _dbgInnerHeight = $state(0);
let _dbgVvHeight = $state(0);
let _dbgVvOffsetTop = $state(0);
let _dbgVvOffsetLeft = $state(0);
let _dbgVvScale = $state(1);
let _dbgWindowScrollY = $state(0);
let _dbgActiveTag = $state('—');
let _dbgFocusedInput = $state(false);
let _dbgLastEvent = $state('init');
let _dbgEventCount = $state(0);

export const ui = {
	get sidebarOpen() {
		return _sidebarOpen;
	},
	get currentView(): AppView {
		return _currentView;
	},
	get conversationMode(): ConversationMode {
		return _conversationMode;
	},
	get taskAuthorFilters(): Record<string, string[]> {
		return _taskAuthorFilters;
	},
	get isMobile() {
		return _windowWidth < 768;
	},
	/** Normalized drag progress (0..1), or null when not dragging. */
	get sidebarDragOffset() {
		return _sidebarDragOffset;
	},
	get isDraggingSidebar() {
		return _sidebarDragOffset !== null;
	},
	/** Thread panel drag offset in pixels, or null when not dragging. */
	get threadDragOffset() {
		return _threadDragOffset;
	},
	/** True when thread panel is animating after swipe release. */
	get threadDragAnimating() {
		return _threadDragAnimating;
	},
	get isDraggingThread() {
		return _threadDragOffset !== null;
	},
	/** True when sidebar is animating after swipe release. */
	get sidebarDragAnimating() {
		return _sidebarDragAnimating;
	},
	get activeWidgetId() {
		return _activeWidgetId;
	},
	get splitWidgetId() {
		return _splitWidgetId;
	},
	get showBoardPanel() {
		return _showBoardPanel;
	},
	get showPinsPanel() {
		return _showPinsPanel;
	},
	get pinsDragOffset() {
		return _pinsDragOffset;
	},
	get pinsDragAnimating() {
		return _pinsDragAnimating;
	},
	get isDraggingPins() {
		return _pinsDragOffset !== null;
	},
	get showSavedDraftsPanel() {
		return _showSavedDraftsPanel;
	},
	get savedDraftsDragOffset() {
		return _savedDraftsDragOffset;
	},
	get savedDraftsDragAnimating() {
		return _savedDraftsDragAnimating;
	},
	get isDraggingSavedDrafts() {
		return _savedDraftsDragOffset !== null;
	},
	get showDebugPanel() {
		return _showDebugPanel;
	},
	/** Panel (widget/board) drag offset in pixels, or null when not dragging. */
	get panelDragOffset() {
		return _panelDragOffset;
	},
	/** True when panel is animating after swipe release. */
	get panelDragAnimating() {
		return _panelDragAnimating;
	},
	get isDraggingPanel() {
		return _panelDragOffset !== null;
	},
	/** True when any inline content panel (widget or board) is open. */
	get hasOpenPanel() {
		return _activeWidgetId !== null || _showBoardPanel;
	},
	get hasOpenSplitPanel() {
		return _splitWidgetId !== null;
	},
	/** Pixel height from visualViewport when keyboard is detected, or null to use 100dvh. */
	get viewportHeight() {
		return _viewportHeight;
	},

	// --- Debug overlay readers (diagnostic only) ---
	get debugMobile() {
		return _debugMobile;
	},
	get dbg() {
		return {
			innerHeight: _dbgInnerHeight,
			vvHeight: _dbgVvHeight,
			vvOffsetTop: _dbgVvOffsetTop,
			vvOffsetLeft: _dbgVvOffsetLeft,
			vvScale: _dbgVvScale,
			windowScrollY: _dbgWindowScrollY,
			activeTag: _dbgActiveTag,
			focusedInput: _dbgFocusedInput,
			lastEvent: _dbgLastEvent,
			eventCount: _dbgEventCount
		};
	},
	setDebugMobile(on: boolean) {
		_debugMobile = on;
		try {
			if (on) localStorage.setItem('threads.debug.vv', '1');
			else localStorage.removeItem('threads.debug.vv');
		} catch {}
	},

	setView(view: AppView) {
		_currentView = view;
	},
	setConversationMode(mode: ConversationMode) {
		_conversationMode = mode;
		try {
			localStorage.setItem(CONVERSATION_MODE_STORAGE_KEY, mode);
		} catch {}
	},
	toggleConversationMode() {
		this.setConversationMode(_conversationMode === 'timeline' ? 'tasks' : 'timeline');
	},
	setTaskAuthorFilter(channelId: string, authorKeys: string[] | null) {
		const nextFilters = { ..._taskAuthorFilters };
		if (authorKeys === null) {
			delete nextFilters[channelId];
		} else {
			nextFilters[channelId] = authorKeys.filter((key, index) => authorKeys.indexOf(key) === index);
		}
		_taskAuthorFilters = nextFilters;
		try {
			if (Object.keys(nextFilters).length > 0) {
				localStorage.setItem(TASK_AUTHOR_FILTERS_STORAGE_KEY, JSON.stringify(nextFilters));
			} else {
				localStorage.removeItem(TASK_AUTHOR_FILTERS_STORAGE_KEY);
			}
		} catch {}
	},

	toggleSidebar() {
		_sidebarOpen = !_sidebarOpen;
	},
	openSidebar() {
		_sidebarOpen = true;
		_sidebarDragOffset = null;
		_sidebarDragAnimating = false;
	},
	closeSidebar() {
		_sidebarOpen = false;
		_sidebarDragOffset = null;
		_sidebarDragAnimating = false;
	},
	/** Set drag progress during interactive swipe. 0 = closed, 1 = open. */
	setSidebarDragOffset(offset: number | null) {
		_sidebarDragOffset = offset;
	},
	/** Set thread panel drag offset in pixels during swipe-to-dismiss. */
	setThreadDragOffset(offset: number | null) {
		_threadDragOffset = offset;
	},
	setThreadDragAnimating(animating: boolean) {
		_threadDragAnimating = animating;
	},
	setPinsDragOffset(offset: number | null) {
		_pinsDragOffset = offset;
	},
	setPinsDragAnimating(animating: boolean) {
		_pinsDragAnimating = animating;
	},
	setSavedDraftsDragOffset(offset: number | null) {
		_savedDraftsDragOffset = offset;
	},
	setSavedDraftsDragAnimating(animating: boolean) {
		_savedDraftsDragAnimating = animating;
	},
	setSidebarDragAnimating(animating: boolean) {
		_sidebarDragAnimating = animating;
	},
	/** Set panel drag offset in pixels during swipe-to-dismiss. */
	setPanelDragOffset(offset: number | null) {
		_panelDragOffset = offset;
	},
	setPanelDragAnimating(animating: boolean) {
		_panelDragAnimating = animating;
	},
	/** Close whichever inline content panel is currently open. */
	closeCurrentPanel() {
		_activeWidgetId = null;
		_showBoardPanel = false;
		_panelDragOffset = null;
		_panelDragAnimating = false;
	},
	closeSplitPanel() {
		_splitWidgetId = null;
	},
	toggleWidget(id: string) {
		if (_activeWidgetId === id) {
			_activeWidgetId = null;
		} else {
			_activeWidgetId = id;
			_splitWidgetId = null;
			_showBoardPanel = false;
			_showPinsPanel = false;
			_showSavedDraftsPanel = false;
		}
	},
	openWidgetSplit(id: string) {
		_splitWidgetId = id;
		_activeWidgetId = null;
		_showBoardPanel = false;
		_showPinsPanel = false;
		_showSavedDraftsPanel = false;
		_showDebugPanel = false;
	},
	closeWidget() {
		_activeWidgetId = null;
		_splitWidgetId = null;
	},
	toggleBoardPanel() {
		_showBoardPanel = !_showBoardPanel;
		if (_showBoardPanel) {
			_splitWidgetId = null;
			_activeWidgetId = null;
			_showPinsPanel = false;
			_showSavedDraftsPanel = false;
		}
	},
	closeBoardPanel() {
		_showBoardPanel = false;
	},
	togglePinsPanel() {
		_showPinsPanel = !_showPinsPanel;
		if (_showPinsPanel) {
			_splitWidgetId = null;
			_activeWidgetId = null;
			_showBoardPanel = false;
			_showSavedDraftsPanel = false;
			_showDebugPanel = false;
		}
	},
	closePinsPanel() {
		_showPinsPanel = false;
		_pinsDragOffset = null;
		_pinsDragAnimating = false;
	},
	toggleSavedDraftsPanel() {
		_showSavedDraftsPanel = !_showSavedDraftsPanel;
		if (_showSavedDraftsPanel) {
			_splitWidgetId = null;
			_activeWidgetId = null;
			_showBoardPanel = false;
			_showPinsPanel = false;
			_showDebugPanel = false;
		}
	},
	closeSavedDraftsPanel() {
		_showSavedDraftsPanel = false;
		_savedDraftsDragOffset = null;
		_savedDraftsDragAnimating = false;
	},
	toggleDebugPanel() {
		_showDebugPanel = !_showDebugPanel;
		if (_showDebugPanel) {
			_splitWidgetId = null;
			_activeWidgetId = null;
			_showBoardPanel = false;
			_showPinsPanel = false;
			_showSavedDraftsPanel = false;
		}
	},
	closeDebugPanel() {
		_showDebugPanel = false;
	},

	/** Call from onMount in the root layout to set up the resize listener. */
	init() {
		if (typeof window === 'undefined') return () => {};
		_windowWidth = window.innerWidth;
		try {
			const storedMode = localStorage.getItem(CONVERSATION_MODE_STORAGE_KEY);
			if (storedMode === 'timeline' || storedMode === 'tasks') {
				_conversationMode = storedMode;
			}
		} catch {}
		try {
			const storedFilters = JSON.parse(localStorage.getItem(TASK_AUTHOR_FILTERS_STORAGE_KEY) ?? '{}');
			if (storedFilters && typeof storedFilters === 'object' && !Array.isArray(storedFilters)) {
				_taskAuthorFilters = Object.fromEntries(
					Object.entries(storedFilters)
						.filter(([, value]) => Array.isArray(value))
						.map(([channelId, value]) => [
							channelId,
							(value as unknown[])
								.filter((item): item is string => typeof item === 'string')
								.filter((item, index, items) => items.indexOf(item) === index)
						])
				);
			} else {
				_taskAuthorFilters = {};
			}
		} catch {
			_taskAuthorFilters = {};
		}

		function onResize() {
			_windowWidth = window.innerWidth;
			// Auto-close sidebar when resizing to desktop
			if (_windowWidth >= 768) {
				_sidebarOpen = false;
			}
		}

		window.addEventListener('resize', onResize);

		// VisualViewport tracking for virtual keyboard on iOS.
		// iOS Safari does NOT shrink dvh/100% when the keyboard opens —
		// interactive-widget=resizes-content is a Chromium-only feature.
		// We listen to visualViewport resize events: when the visual viewport
		// height is significantly smaller than the window height, the keyboard
		// is open and we set an explicit pixel height on the app shell.
		const vv = window.visualViewport;
		let cleanupVV = () => {};
		if (vv) {
			// Threshold: if visualViewport is more than 100px shorter than the
			// window, a keyboard is likely open. We use window.innerHeight as the
			// "full" reference because it doesn't change when the keyboard opens
			// on iOS (unlike visualViewport.height which does).
			function onViewportResize() {
				if (!vv) return;
				const full = window.innerHeight;
				const current = vv.height;
				// Account for visual viewport offset (iOS scrolls the viewport up)
				if (full - current > 100) {
					// Keyboard is open — set explicit height
					_viewportHeight = current;
				} else {
					// Keyboard closed — revert to CSS-driven height
					_viewportHeight = null;
				}
			}

			vv.addEventListener('resize', onViewportResize);
			vv.addEventListener('scroll', onViewportResize);
			cleanupVV = () => {
				vv.removeEventListener('resize', onViewportResize);
				vv.removeEventListener('scroll', onViewportResize);
			};
		}

		// --- Debug overlay wiring (diagnostic only, opt-in via localStorage) ---
		let cleanupDebug = () => {};
		try {
			const params = new URLSearchParams(window.location.search);
			if (params.get('debug') === 'vv') {
				localStorage.setItem('threads.debug.vv', '1');
			}
			if (localStorage.getItem('threads.debug.vv') === '1') {
				_debugMobile = true;
			}
		} catch {}

		if (_debugMobile) {
			let rafPending = false;
			const sample = (label: string) => {
				_dbgLastEvent = label;
				_dbgEventCount = _dbgEventCount + 1;
				if (rafPending) return;
				rafPending = true;
				requestAnimationFrame(() => {
					rafPending = false;
					_dbgInnerHeight = window.innerHeight;
					_dbgWindowScrollY = window.scrollY;
					const v = window.visualViewport;
					if (v) {
						_dbgVvHeight = Math.round(v.height);
						_dbgVvOffsetTop = Math.round(v.offsetTop);
						_dbgVvOffsetLeft = Math.round(v.offsetLeft);
						_dbgVvScale = Number(v.scale.toFixed(2));
					}
					const ae = document.activeElement as HTMLElement | null;
					_dbgActiveTag = ae ? `${ae.tagName.toLowerCase()}${ae.id ? '#' + ae.id : ''}` : '—';
					const tag = ae?.tagName;
					_dbgFocusedInput =
						tag === 'TEXTAREA' ||
						tag === 'INPUT' ||
						(ae?.hasAttribute('contenteditable') ?? false);
				});
			};

			const onWinScroll = () => sample('win.scroll');
			const onWinResize = () => sample('win.resize');
			const onVvResize = () => sample('vv.resize');
			const onVvScroll = () => sample('vv.scroll');
			const onFocusIn = (e: FocusEvent) => {
				sample(`focusin:${(e.target as HTMLElement | null)?.tagName?.toLowerCase() ?? '?'}`);
			};
			const onFocusOut = (e: FocusEvent) => {
				sample(`focusout:${(e.target as HTMLElement | null)?.tagName?.toLowerCase() ?? '?'}`);
			};

			window.addEventListener('scroll', onWinScroll, { passive: true });
			window.addEventListener('resize', onWinResize);
			document.addEventListener('focusin', onFocusIn, true);
			document.addEventListener('focusout', onFocusOut, true);
			if (vv) {
				vv.addEventListener('resize', onVvResize);
				vv.addEventListener('scroll', onVvScroll);
			}
			sample('init');

			cleanupDebug = () => {
				window.removeEventListener('scroll', onWinScroll);
				window.removeEventListener('resize', onWinResize);
				document.removeEventListener('focusin', onFocusIn, true);
				document.removeEventListener('focusout', onFocusOut, true);
				if (vv) {
					vv.removeEventListener('resize', onVvResize);
					vv.removeEventListener('scroll', onVvScroll);
				}
			};
		}

		return () => {
			window.removeEventListener('resize', onResize);
			cleanupVV();
			cleanupDebug();
		};
	}
};
