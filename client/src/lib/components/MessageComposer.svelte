<script lang="ts">
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import { api } from '$lib/api.js';
	import MentionAutocomplete from './MentionAutocomplete.svelte';
	import ChannelAutocomplete from './ChannelAutocomplete.svelte';
	import FileIcon from 'phosphor-svelte/lib/File';
	import Paperclip from 'phosphor-svelte/lib/Paperclip';
	import Check from 'phosphor-svelte/lib/Check';
	import PaperPlaneTilt from 'phosphor-svelte/lib/PaperPlaneTilt';
	import FloppyDisk from 'phosphor-svelte/lib/FloppyDisk';
	import Microphone from 'phosphor-svelte/lib/Microphone';
	import Stop from 'phosphor-svelte/lib/Stop';
	import CircleNotch from 'phosphor-svelte/lib/CircleNotch';

	interface Member {
		user_id: string;
		username: string;
		display_name: string | null;
	}

	interface DraftAttachment {
		id: string;
		filename: string;
		contentType: string;
		sizeBytes: number;
		url: string;
	}

	interface PendingFile {
		file: File;
		id?: string;
		uploading: boolean;
		error?: string;
		preview?: string;
		// When restored from a draft, there's no File object -- use these instead
		draftFilename?: string;
		draftUrl?: string;
	}

	interface ChannelInfo {
		id: string;
		name: string;
	}

	interface EditingMessage {
		id: string;
		content: string;
	}

	interface Props {
		onsend: (content: string, attachmentIds?: string[], metadata?: Record<string, unknown>, idempotencyKey?: string) => void | Promise<unknown>;
		ontypingstart?: () => void;
		ontypingstop?: () => void;
		placeholder?: string;
		focusTrigger?: unknown;
		channelId?: string;
		loadDraft?: (channelId: string) => Promise<{ content: string; attachments: DraftAttachment[] }>;
		saveDraft?: (channelId: string, content: string, attachmentIds: string[]) => void;
		members?: Member[];
		channels?: ChannelInfo[];
		externalFiles?: File[] | null;
		onexternalfilesconsumed?: () => void;
		editingMessage?: EditingMessage | null;
		oneditsubmit?: (messageId: string, content: string) => void | Promise<unknown>;
		oneditcancel?: () => void;
		onsavedraft?: (content: string) => void;
		loadedDraftContent?: string | null;
		onloadeddraftconsumed?: () => void;
		/** When set, renders a model picker above the composer that prepends metadata.model on send. */
		availableModels?: string[] | null;
		/** Unique key for persisting the picker's last choice in localStorage (e.g. DM recipient id). */
		modelPickerKey?: string | null;
		/** Preferred default model id (falls back to first option if not in availableModels). */
		defaultModel?: string | null;
		disabledReason?: string | null;
	}

	let { onsend, ontypingstart, ontypingstop, placeholder = 'Type a message...', focusTrigger, channelId, loadDraft, saveDraft, members = [], channels: channelsList = [], externalFiles = null, onexternalfilesconsumed, editingMessage = null, oneditsubmit, oneditcancel, onsavedraft, loadedDraftContent = null, onloadeddraftconsumed, availableModels = null, modelPickerKey = null, defaultModel = null, disabledReason = null }: Props = $props();

	// Model picker state (tela DM only — gated by availableModels prop on caller side)
	const PICKER_STORAGE_PREFIX = 'tela-model:';
	let selectedModel = $state<string | null>(null);
	$effect(() => {
		if (!availableModels || availableModels.length === 0) {
			selectedModel = null;
			return;
		}
		const key = modelPickerKey ? `${PICKER_STORAGE_PREFIX}${modelPickerKey}` : null;
		let initial: string | null = null;
		if (key && typeof localStorage !== 'undefined') {
			initial = localStorage.getItem(key);
		}
		// Validate stored choice against current list; fall back to defaultModel or first option.
		if (!initial || !availableModels.includes(initial)) {
			initial = defaultModel && availableModels.includes(defaultModel)
				? defaultModel
				: availableModels[0];
		}
		selectedModel = initial;
	});
	function onModelChange() {
		if (modelPickerKey && selectedModel && typeof localStorage !== 'undefined') {
			try {
				localStorage.setItem(`${PICKER_STORAGE_PREFIX}${modelPickerKey}`, selectedModel);
			} catch {
				// ignore quota / private-mode errors
			}
		}
	}

	let content = $state('');
	let sendInFlight = $state(false);
	let sendError = $state<string | null>(null);
	let typingTimeout: ReturnType<typeof setTimeout> | null = null;
	let isTyping = $state(false);
	let textareaEl: HTMLTextAreaElement | undefined = $state();
	let fileInputEl: HTMLInputElement | undefined = $state();
	let draftTimeout: ReturnType<typeof setTimeout> | null = null;
	let pendingFiles = $state<PendingFile[]>([]);

	// Voice-to-text recording state. `recordingSupported` gates the mic button so
	// it never appears in browsers without MediaRecorder/getUserMedia.
	let isRecording = $state(false);
	let isTranscribing = $state(false);
	let recordError = $state<string | null>(null);
	let recordingSupported = $state(false);
	let mediaRecorder: MediaRecorder | null = null;
	let mediaStream: MediaStream | null = null;
	let audioChunks: Blob[] = [];

	// Mention autocomplete state
	let mentionQuery = $state('');
	let mentionVisible = $state(false);
	let mentionStartIndex = $state(-1);
	let autocompleteRef: MentionAutocomplete | undefined = $state();

	// Channel autocomplete state
	let channelQuery = $state('');
	let channelVisible = $state(false);
	let channelStartIndex = $state(-1);
	let channelAutocompleteRef: ChannelAutocomplete | undefined = $state();

	// Populate composer when entering edit mode
	$effect(() => {
		if (editingMessage) {
			content = editingMessage.content;
			tick().then(() => {
				autoResize();
				if (textareaEl) {
					textareaEl.focus();
					// Place cursor at end of content
					const len = textareaEl.value.length;
					textareaEl.selectionStart = len;
					textareaEl.selectionEnd = len;
				}
			});
		}
	});

	let hasContent = $derived(content.trim().length > 0 || pendingFiles.some(f => f.id));
	let isUploading = $derived(pendingFiles.some(f => f.uploading));

	async function uploadFiles(files: FileList | File[]) {
		for (const file of Array.from(files)) {
			const pending: PendingFile = { file, uploading: true };
			if (file.type.startsWith('image/')) {
				pending.preview = URL.createObjectURL(file);
			}
			pendingFiles = [...pendingFiles, pending];

			try {
				const result = await api.uploads.upload(file);
				pendingFiles = pendingFiles.map(p =>
					p.file === file ? { ...p, id: result.id, uploading: false } : p
				);
				// Persist the new attachment ID to the draft
				scheduleDraftSave();
			} catch (err: any) {
				pendingFiles = pendingFiles.map(p =>
					p.file === file ? { ...p, uploading: false, error: err.message } : p
				);
			}
		}
	}

	function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = input.files;
		if (!files || files.length === 0) {
			// Cancelled — return focus to textarea
			textareaEl?.focus();
			return;
		}
		uploadFiles(files);
		// Reset input so same file can be selected again
		input.value = '';
		// Return focus to textarea after selecting files
		textareaEl?.focus();
	}

	function handlePaste(e: ClipboardEvent) {
		const files = e.clipboardData?.files;
		if (files && files.length > 0) {
			e.preventDefault();
			uploadFiles(files);
		}
	}

	function removeFile(idx: number) {
		const removed = pendingFiles[idx];
		if (removed.preview && !removed.draftUrl) URL.revokeObjectURL(removed.preview);
		pendingFiles = pendingFiles.filter((_, i) => i !== idx);
		// Persist the removal to the draft
		scheduleDraftSave();
	}

	// Pick up externally loaded draft content (from saved drafts panel)
	$effect(() => {
		if (loadedDraftContent !== null && loadedDraftContent !== undefined) {
			content = loadedDraftContent;
			onloadeddraftconsumed?.();
			tick().then(() => {
				autoResize();
				if (textareaEl) {
					textareaEl.focus();
					const len = textareaEl.value.length;
					textareaEl.selectionStart = len;
					textareaEl.selectionEnd = len;
				}
			});
		}
	});

	// Pick up externally dropped files (e.g. drag-and-drop on message area)
	$effect(() => {
		if (sendInFlight) return;
		if (externalFiles && externalFiles.length > 0) {
			uploadFiles(externalFiles);
			onexternalfilesconsumed?.();
		}
	});

	// Load draft when channel changes
	$effect(() => {
		const cid = channelId;
		if (!cid || !loadDraft) return;
		// Clear pending files when switching channels so stale attachments don't linger
		// Use untrack to avoid reading pendingFiles as a dependency (which would cause infinite loop)
		untrack(() => {
			for (const f of pendingFiles) {
				if (f.preview && !f.draftUrl) URL.revokeObjectURL(f.preview);
			}
			pendingFiles = [];
		});
		loadDraft(cid).then((draft) => {
			// Only set if we're still on the same channel
			if (channelId === cid) {
				// Don't clobber anything the user typed/attached while the draft
				// request was in flight
				const typed = (textareaEl?.value ?? content).trim();
				if (typed || pendingFiles.length > 0) return;
				content = draft.content;
				// Restore draft attachments as already-uploaded pending files
				pendingFiles = draft.attachments.map(a => ({
					file: new File([], a.filename), // placeholder File object
					id: a.id,
					uploading: false,
					draftFilename: a.filename,
					draftUrl: a.url,
					preview: a.contentType.startsWith('image/') ? a.url : undefined,
				}));
				tick().then(() => autoResize());
			}
		});
	});

	// On mobile, don't auto-focus the textarea -- it opens the virtual keyboard
	// before the layout is settled, causing content to scroll off screen.
	// Let the user tap to focus instead.
	function isMobileDevice(): boolean {
		if (typeof window === 'undefined') return false;
		return window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 768;
	}

	// Auto-focus on mount (e.g. when thread panel opens)
	onMount(() => {
		recordingSupported =
			typeof navigator !== 'undefined' &&
			!!navigator.mediaDevices?.getUserMedia &&
			typeof MediaRecorder !== 'undefined';
		if (!isMobileDevice()) {
			textareaEl?.focus();
		}
	});

	// Stop any in-flight recording and release the mic when the composer unmounts
	// (e.g. switching channels or closing the thread panel mid-recording).
	onDestroy(() => {
		if (mediaRecorder && isRecording) {
			try {
				mediaRecorder.stop();
			} catch {
				// already stopped
			}
		}
		stopStreamTracks();
	});

	// Re-focus when focusTrigger changes (e.g. channel select)
	$effect(() => {
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		focusTrigger;
		if (!isMobileDevice()) {
			tick().then(() => textareaEl?.focus());
		}
	});

	function detectMention() {
		if (!textareaEl) return;
		const cursorPos = textareaEl.selectionStart;
		const textBeforeCursor = content.slice(0, cursorPos);

		// Find the last @ that starts a mention (preceded by start-of-string or whitespace)
		const match = textBeforeCursor.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
		if (match) {
			mentionVisible = true;
			mentionQuery = match[1];
			mentionStartIndex = cursorPos - match[1].length - 1; // position of @
		} else {
			mentionVisible = false;
			mentionQuery = '';
			mentionStartIndex = -1;
		}
	}

	function detectChannel() {
		if (!textareaEl) return;
		const cursorPos = textareaEl.selectionStart;
		const textBeforeCursor = content.slice(0, cursorPos);

		// Find the last # that starts a channel ref (preceded by start-of-string or whitespace)
		const match = textBeforeCursor.match(/(?:^|\s)#([a-zA-Z0-9_-]*)$/);
		if (match) {
			channelVisible = true;
			channelQuery = match[1];
			channelStartIndex = cursorPos - match[1].length - 1; // position of #
		} else {
			channelVisible = false;
			channelQuery = '';
			channelStartIndex = -1;
		}
	}

	function handleChannelSelect(channelName: string) {
		if (!channelName) {
			// Escape pressed, just close
			channelVisible = false;
			return;
		}

		const before = content.slice(0, channelStartIndex);
		const after = content.slice(channelStartIndex + channelQuery.length + 1); // +1 for #
		content = `${before}#${channelName} ${after}`;
		channelVisible = false;
		channelQuery = '';
		channelStartIndex = -1;

		tick().then(() => {
			if (textareaEl) {
				const newCursorPos = before.length + channelName.length + 2; // #channel-name + space
				textareaEl.selectionStart = newCursorPos;
				textareaEl.selectionEnd = newCursorPos;
				textareaEl.focus();
				autoResize();
			}
		});
	}

	function handleMentionSelect(username: string) {
		if (!username) {
			// Escape pressed, just close
			mentionVisible = false;
			return;
		}

		const before = content.slice(0, mentionStartIndex);
		const after = content.slice(mentionStartIndex + mentionQuery.length + 1); // +1 for @
		content = `${before}@${username} ${after}`;
		mentionVisible = false;
		mentionQuery = '';
		mentionStartIndex = -1;

		tick().then(() => {
			if (textareaEl) {
				const newCursorPos = before.length + username.length + 2; // @username + space
				textareaEl.selectionStart = newCursorPos;
				textareaEl.selectionEnd = newCursorPos;
				textareaEl.focus();
				autoResize();
			}
		});
	}

	function handleKeydown(e: KeyboardEvent) {
		// Let autocomplete handle navigation keys first
		if (mentionVisible && autocompleteRef) {
			const handled = autocompleteRef.handleKeydown(e);
			if (handled) return;
		}
		if (channelVisible && channelAutocompleteRef) {
			const handled = channelAutocompleteRef.handleKeydown(e);
			if (handled) return;
		}

		if (e.key === 'Escape' && editingMessage) {
			e.preventDefault();
			cancelEdit();
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey && !isMobileDevice()) {
			e.preventDefault();
			send();
			return;
		}
		if (disabledReason) return;
		// Typing indicator
		if (!isTyping && content.length > 0) {
			isTyping = true;
			ontypingstart?.();
		}
		if (typingTimeout) clearTimeout(typingTimeout);
		typingTimeout = setTimeout(() => {
			isTyping = false;
			ontypingstop?.();
		}, 3000);
	}

	function cancelEdit() {
		content = '';
		oneditcancel?.();
		if (textareaEl) {
			textareaEl.style.height = 'auto';
		}
	}

	async function send() {
		if (disabledReason) return;
		if (sendInFlight) return;
		// Read text from the DOM element directly: OS voice dictation can desync
		// Svelte's bind:value from the actual DOM value.
		const text = (textareaEl?.value ?? content).trim();
		// In edit mode, submit the edit; only clear once the edit succeeds so a
		// failed PATCH doesn't lose the user's changes.
		if (editingMessage) {
			if (text && text !== editingMessage.content) {
				sendInFlight = true;
				sendError = null;
				try {
					await oneditsubmit?.(editingMessage.id, text);
				} catch {
					sendError = 'Failed to save edit';
					return;
				} finally {
					sendInFlight = false;
				}
			} else {
				oneditcancel?.();
			}
			content = '';
			if (textareaEl) {
				textareaEl.value = '';
				textareaEl.style.height = 'auto';
			}
			return;
		}
		const attachmentIds = pendingFiles.filter(f => f.id).map(f => f.id!);
		if (!text && attachmentIds.length === 0) return;
		if (isUploading) return; // wait for uploads to finish

		const metadata = selectedModel ? { model: selectedModel } : undefined;
		const sendKey = crypto.randomUUID();
		const sendChannelId = channelId;
		const sendingFiles = pendingFiles;

		// Submission is fully optimistic: clear and unlock the composer in this
		// same event turn. The owner inserts a temporary timeline row synchronously
		// and owns later delivery/reconciliation state.
		sendError = null;
		content = '';
		pendingFiles = [];
		mentionVisible = false;
		channelVisible = false;
		if (textareaEl) {
			textareaEl.value = '';
			textareaEl.style.height = 'auto';
		}
		if (isTyping) {
			isTyping = false;
			ontypingstop?.();
		}
		if (typingTimeout) {
			clearTimeout(typingTimeout);
			typingTimeout = null;
		}

		// Clear the persisted draft immediately too; delivery failures remain as
		// visible failed rows in the timeline rather than repopulating this input.
		if (draftTimeout) {
			clearTimeout(draftTimeout);
			draftTimeout = null;
		}
		if (sendChannelId && saveDraft) {
			saveDraft(sendChannelId, '', []);
		}

		try {
			// Do not await network delivery. This lets another message be composed
			// while this one is still pending. Page/thread handlers consume errors by
			// marking the corresponding temporary row as failed.
			void Promise.resolve(
				onsend(text, attachmentIds.length > 0 ? attachmentIds : undefined, metadata, sendKey)
			).catch(() => {});
		} catch {
			// A synchronous callback failure is treated the same as a rejected send;
			// the owning timeline is responsible for surfacing it.
		}

		// Uploaded blobs no longer belong to the composer after submission.
		for (const f of sendingFiles) {
			if (f.preview) URL.revokeObjectURL(f.preview);
		}
		if (channelId === sendChannelId) {
			tick().then(() => {
				if (!isMobileDevice()) textareaEl?.focus();
			});
		}
	}

	function getUploadedAttachmentIds(): string[] {
		return pendingFiles.filter(f => f.id).map(f => f.id!);
	}

	function scheduleDraftSave() {
		if (!channelId || !saveDraft) return;
		if (draftTimeout) clearTimeout(draftTimeout);
		const cid = channelId;
		const text = content;
		const aids = getUploadedAttachmentIds();
		// Clear draft immediately when input is empty and no attachments so the sidebar icon disappears
		if (!text.trim() && aids.length === 0) {
			saveDraft(cid, '', []);
			return;
		}
		draftTimeout = setTimeout(() => {
			saveDraft(cid, text, aids);
		}, 500);
	}

	function autoResize() {
		if (textareaEl) {
			textareaEl.style.height = 'auto';
			textareaEl.style.height = Math.min(textareaEl.scrollHeight, 200) + 'px';
		}
	}

	function handleInput() {
		sendError = null;
		autoResize();
		scheduleDraftSave();
		detectMention();
		detectChannel();
	}

	// Voice dictation (iOS, Android, macOS) uses the composition API. When
	// dictation finishes, the browser fires compositionend but some WebKit
	// builds do not emit the synthetic `input` event that Svelte's bind:value
	// relies on to sync state. Explicitly pull the DOM value into `content` so
	// the reactive state stays accurate and `send()` can clear it later.
	function handleCompositionEnd() {
		if (textareaEl) {
			content = textareaEl.value;
		}
		autoResize();
		scheduleDraftSave();
	}

	function handleFocus() {
		// iOS Safari scrolls the document when focusing inputs, pushing the
		// top bar off screen. Reset scroll immediately and again after the
		// keyboard animation completes (~300ms) since iOS may re-scroll.
		function resetScroll() {
			window.scrollTo(0, 0);
			document.documentElement.scrollTop = 0;
			document.body.scrollTop = 0;
		}
		requestAnimationFrame(resetScroll);
		setTimeout(resetScroll, 350);
	}

	// --- Voice-to-text (press-to-record) ---

	// Pick a container the browser can actually record. Chrome/Firefox produce
	// webm/opus; Safari produces mp4. Whisper decodes all of them server-side.
	function pickAudioMimeType(): string | undefined {
		if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return undefined;
		const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
		return candidates.find((t) => MediaRecorder.isTypeSupported(t));
	}

	function stopStreamTracks() {
		if (mediaStream) {
			for (const track of mediaStream.getTracks()) track.stop();
			mediaStream = null;
		}
	}

	async function toggleRecording() {
		if (isTranscribing) return;
		if (isRecording) {
			stopRecording();
		} else {
			await startRecording();
		}
	}

	async function startRecording() {
		if (isRecording || isTranscribing) return;
		recordError = null;
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
			recordError = 'Recording is not supported in this browser';
			return;
		}
		try {
			mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			recordError = 'Microphone access was blocked';
			return;
		}
		audioChunks = [];
		const mimeType = pickAudioMimeType();
		try {
			mediaRecorder = mimeType
				? new MediaRecorder(mediaStream, { mimeType })
				: new MediaRecorder(mediaStream);
		} catch {
			mediaRecorder = new MediaRecorder(mediaStream);
		}
		mediaRecorder.ondataavailable = (e) => {
			if (e.data.size > 0) audioChunks.push(e.data);
		};
		mediaRecorder.onstop = handleRecordingStop;
		mediaRecorder.start();
		isRecording = true;
	}

	function stopRecording() {
		if (!mediaRecorder || !isRecording) return;
		// onstop fires after the final dataavailable and runs the transcription.
		try {
			mediaRecorder.stop();
		} catch {
			stopStreamTracks();
		}
		isRecording = false;
	}

	async function handleRecordingStop() {
		const recorder = mediaRecorder;
		mediaRecorder = null;
		stopStreamTracks();
		const type = recorder?.mimeType || 'audio/webm';
		const blob = new Blob(audioChunks, { type });
		audioChunks = [];
		if (blob.size === 0) return;
		isTranscribing = true;
		try {
			const { text } = await api.transcribe(blob);
			insertTranscript(text);
		} catch {
			recordError = 'Could not transcribe audio';
		} finally {
			isTranscribing = false;
		}
	}

	// Drop the transcript in at the cursor (or replace the selection), matching
	// how mention/channel autocomplete edits the composer.
	function insertTranscript(text: string) {
		const trimmed = text.trim();
		if (!trimmed) {
			recordError = 'No speech detected';
			return;
		}
		const el = textareaEl;
		const current = el?.value ?? content;
		const start = el?.selectionStart ?? current.length;
		const end = el?.selectionEnd ?? current.length;
		const before = current.slice(0, start);
		const after = current.slice(end);
		const needsSpace = before.length > 0 && !/\s$/.test(before);
		const insertion = (needsSpace ? ' ' : '') + trimmed;
		content = before + insertion + after;
		scheduleDraftSave();
		tick().then(() => {
			if (el) {
				// Keep the DOM value in sync (same dictation-desync guard as send()).
				el.value = content;
				const pos = before.length + insertion.length;
				el.selectionStart = pos;
				el.selectionEnd = pos;
				el.focus();
				autoResize();
			}
		});
	}
</script>

<div class="px-4 pt-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] pb-safe shrink-0">
	{#if availableModels && availableModels.length > 0 && selectedModel}
		<div class="flex items-center gap-2 px-1 pb-2 text-xs text-[var(--color-text-muted)]">
			<label for="model-picker" class="shrink-0">Model:</label>
			<select
				id="model-picker"
				bind:value={selectedModel}
				onchange={onModelChange}
				class="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded px-2 py-0.5 text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
			>
				{#each availableModels as m (m)}
					<option value={m}>{m}</option>
				{/each}
			</select>
		</div>
	{/if}
	{#if editingMessage}
		<div class="flex items-center justify-between px-1 pb-1 text-xs text-[var(--color-text-muted)]">
			<span>Editing message</span>
			<button onclick={cancelEdit} class="hover:text-[var(--color-text)]">Cancel</button>
		</div>
	{/if}
	{#if sendError}
		<div class="flex items-center justify-between px-1 pb-1 text-xs text-[var(--color-danger,#ef4444)]" role="alert">
			<span>{sendError} — check your connection</span>
			<button onclick={send} class="underline hover:no-underline">Retry</button>
		</div>
	{/if}
	{#if recordError}
		<div class="flex items-center justify-between px-1 pb-1 text-xs text-[var(--color-danger,#ef4444)]" role="alert">
			<span>{recordError}</span>
			<button onclick={() => (recordError = null)} class="underline hover:no-underline">Dismiss</button>
		</div>
	{/if}
	{#if pendingFiles.length > 0}
		<div class="flex gap-2 mb-2 overflow-x-auto pb-1">
			{#each pendingFiles as pf, i (i)}
				<div class="relative shrink-0 group/file">
					{#if pf.preview}
						<img src={pf.preview} alt={pf.file.name} class="w-16 h-16 object-cover rounded-lg border border-[var(--color-border)]" />
					{:else}
						<div class="w-16 h-16 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] flex flex-col items-center justify-center p-1">
							<FileIcon size={20} class="text-[var(--color-text-muted)]" />
							<span class="text-[9px] text-[var(--color-text-muted)] truncate w-full text-center mt-0.5">{pf.draftFilename || pf.file.name}</span>
						</div>
					{/if}
					{#if pf.uploading}
						<div class="absolute inset-0 bg-black/40 rounded-lg flex items-center justify-center">
							<div class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
						</div>
					{/if}
					{#if pf.error}
						<div class="absolute inset-0 bg-red-900/60 rounded-lg flex items-center justify-center">
							<span class="text-[10px] text-white">Error</span>
						</div>
					{/if}
					<button
						onclick={() => removeFile(i)}
						class="absolute -top-1.5 -right-1.5 w-5 h-5 bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-full flex items-center justify-center text-xs text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
					>
						&times;
					</button>
				</div>
			{/each}
		</div>
	{/if}
	<div
		class="relative flex flex-wrap items-end bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded-lg focus-within:border-[var(--color-accent)] transition-colors"
	>
		<MentionAutocomplete
			bind:this={autocompleteRef}
			members={members}
			query={mentionQuery}
			onselect={handleMentionSelect}
			visible={mentionVisible}
		/>
		<ChannelAutocomplete
			bind:this={channelAutocompleteRef}
			channels={channelsList}
			query={channelQuery}
			onselect={handleChannelSelect}
			visible={channelVisible}
		/>
		<input
			bind:this={fileInputEl}
			type="file"
			multiple
			onchange={handleFileSelect}
			class="hidden"
			accept="*/*"
		/>
		<!-- Attach button: below textarea on mobile, left side on desktop -->
		<button
			onclick={() => fileInputEl?.click()}
			disabled={!!disabledReason || sendInFlight}
			class="order-2 px-2.5 py-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors shrink-0 disabled:opacity-50 disabled:hover:text-[var(--color-text-muted)]"
			title={disabledReason ?? 'Attach file'}
		>
			<Paperclip size={20} />
		</button>
		<!-- Voice-to-text: record a memo and transcribe it into the composer -->
		{#if recordingSupported}
			<button
				onclick={toggleRecording}
				disabled={!!disabledReason || sendInFlight || isUploading || isTranscribing}
				class="order-2 px-2.5 py-1.5 transition-colors shrink-0 disabled:opacity-50 {isRecording ? 'text-[var(--color-danger,#ef4444)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:hover:text-[var(--color-text-muted)]'}"
				title={isRecording ? 'Stop recording' : isTranscribing ? 'Transcribing…' : 'Record a voice message'}
				aria-label={isRecording ? 'Stop recording' : 'Record a voice message'}
			>
				{#if isTranscribing}
					<CircleNotch size={20} class="animate-spin" />
				{:else if isRecording}
					<Stop size={20} weight="fill" />
				{:else}
					<Microphone size={20} />
				{/if}
			</button>
		{/if}
		<!-- Textarea: full width on mobile (forces buttons to wrap below), inline on desktop -->
		<textarea
			bind:this={textareaEl}
			bind:value={content}
			onkeydown={handleKeydown}
			oninput={handleInput}
			oncompositionend={handleCompositionEnd}
			onfocus={handleFocus}
			onpaste={handlePaste}
			placeholder={disabledReason ?? (editingMessage ? 'Editing message... (Escape to cancel)' : placeholder)}
			disabled={!!disabledReason || sendInFlight}
			rows="1"
			class="order-1 w-full bg-transparent px-3 py-2.5 text-sm leading-relaxed resize-none focus:outline-none max-h-[200px] disabled:cursor-not-allowed disabled:text-[var(--color-text-muted)]"
			style="font-size: 16px; touch-action: manipulation; overflow-y: auto; overscroll-behavior: contain;"
		></textarea>
		<!-- Save to drafts button -->
		{#if onsavedraft && hasContent && !editingMessage}
			<button
				onclick={(e) => {
					const text = (textareaEl?.value ?? content).trim();
					if (!text) return;
					onsavedraft(text);
					content = '';
					if (textareaEl) {
						textareaEl.value = '';
						textareaEl.style.height = 'auto';
						textareaEl.focus();
					}
					if (channelId && saveDraft) {
						saveDraft(channelId, '', []);
					}
					const btn = e.currentTarget;
					btn.classList.add('draft-saved-flash');
					setTimeout(() => btn.classList.remove('draft-saved-flash'), 600);
				}}
				class="order-3 px-2 py-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors shrink-0"
				title="Save as draft"
			>
				<FloppyDisk size={20} />
			</button>
		{/if}
		<!-- Send button: right-aligned below textarea on mobile, right side on desktop -->
		<button
			onclick={send}
			disabled={!!disabledReason || !hasContent || isUploading || sendInFlight}
			class="order-4 ml-auto px-3 py-1.5 text-[var(--color-accent)] disabled:text-[var(--color-text-muted)] disabled:opacity-50 hover:text-[var(--color-accent-hover)] transition-colors shrink-0"
			title={editingMessage ? 'Save edit' : 'Send message'}
		>
			{#if editingMessage}
				<Check size={20} weight="bold" />
			{:else}
				<PaperPlaneTilt size={20} weight="fill" />
			{/if}
		</button>
	</div>
</div>

<style>
	:global(.draft-saved-flash) {
		color: var(--color-success, #22c55e) !important;
		transition: color 0.15s ease;
	}
</style>
