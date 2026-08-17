<script lang="ts">
	import { board, type KanbanCard } from '$lib/state/board.svelte.js';
	import { ui } from '$lib/state/ui.svelte.js';
	import Plus from 'phosphor-svelte/lib/Plus';
	import Trash from 'phosphor-svelte/lib/Trash';
	import X from 'phosphor-svelte/lib/X';
	import Kanban from 'phosphor-svelte/lib/Kanban';
	import CaretLeft from 'phosphor-svelte/lib/CaretLeft';

	let { channelId }: { channelId: string } = $props();

	function handleClose() {
		if (ui.isMobile) {
			const screenWidth = window.innerWidth;
			ui.setPanelDragAnimating(true);
			ui.setPanelDragOffset(screenWidth);
			setTimeout(() => {
				ui.closeCurrentPanel();
			}, 200);
		} else {
			ui.closeBoardPanel();
		}
	}

	const COLUMN_LABELS: Record<string, string> = {
		'todo': 'To Do',
		'in-progress': 'In Progress',
		'review': 'Review',
		'done': 'Done'
	};

	const PRIORITY_COLORS: Record<string, string> = {
		'urgent': 'bg-red-500/20 text-red-400 border-red-500/30',
		'high': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
		'normal': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
		'low': 'bg-gray-500/20 text-gray-400 border-gray-500/30'
	};

	// Quick-add inputs per column
	let quickAddInputs = $state<Record<string, string>>({});

	// Drag state
	let draggingCardId = $state<string | null>(null);
	let dragOverColumn = $state<string | null>(null);
	let dragOverCardId = $state<string | null>(null);

	// Delete confirmation
	let confirmDeleteId = $state<string | null>(null);

	// Edit modal state
	let editTitle = $state('');
	let editDescription = $state('');
	let editPriority = $state('normal');
	let editAssignee = $state('');

	$effect(() => {
		const id = channelId;
		board.loadBoard(id);
	});

	$effect(() => {
		const card = board.editingCard;
		if (card) {
			editTitle = card.title;
			editDescription = card.description ?? '';
			editPriority = card.priority;
			editAssignee = card.assignee ?? '';
		}
	});

	async function handleQuickAdd(columnKey: string) {
		const title = quickAddInputs[columnKey]?.trim();
		if (!title) return;
		quickAddInputs[columnKey] = '';
		await board.createCard(channelId, { title, column_key: columnKey });
	}

	function handleDragStart(e: DragEvent, card: KanbanCard) {
		draggingCardId = card.id;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', card.id);
		}
	}

	function handleDragEnd() {
		draggingCardId = null;
		dragOverColumn = null;
		dragOverCardId = null;
	}

	function handleColumnDragOver(e: DragEvent, columnKey: string) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOverColumn = columnKey;
	}

	function handleCardDragOver(e: DragEvent, cardId: string) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOverCardId = cardId;
	}

	function handleColumnDragLeave() {
		dragOverColumn = null;
		dragOverCardId = null;
	}

	async function handleDrop(e: DragEvent, columnKey: string) {
		e.preventDefault();
		if (!draggingCardId) return;

		const columnCards = board.cardsByColumn(columnKey);

		let position: number;
		if (dragOverCardId && dragOverCardId !== draggingCardId) {
			// Drop near a specific card - calculate position
			const targetIdx = columnCards.findIndex((c) => c.id === dragOverCardId);
			if (targetIdx >= 0) {
				const target = columnCards[targetIdx];
				const prev = targetIdx > 0 ? columnCards[targetIdx - 1] : null;
				// Insert before the target card
				if (prev) {
					position = (prev.position + target.position) / 2;
				} else {
					position = target.position / 2;
				}
			} else {
				position = columnCards.length > 0 ? columnCards[columnCards.length - 1].position + 1000 : 1000;
			}
		} else {
			// Drop at end of column
			position = columnCards.length > 0 ? columnCards[columnCards.length - 1].position + 1000 : 1000;
		}

		await board.moveCard(draggingCardId, columnKey, position);
		draggingCardId = null;
		dragOverColumn = null;
		dragOverCardId = null;
	}

	async function handleEditSave() {
		const card = board.editingCard;
		if (!card) return;
		await board.updateCard(card.id, {
			title: editTitle,
			description: editDescription || undefined,
			priority: editPriority,
			assignee: editAssignee || null
		});
		board.setEditingCard(null);
	}

	async function handleDelete(cardId: string) {
		await board.deleteCard(cardId);
		confirmDeleteId = null;
	}
</script>

<div class="flex-1 flex flex-col min-h-0 bg-[var(--color-bg)]">
	{#if ui.isMobile}
		<div
			class="h-12 px-4 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] relative z-10"
		>
			<div class="flex items-center gap-2">
				<button
					onclick={handleClose}
					class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors -ml-1 p-1"
					title="Back"
				>
					<CaretLeft size={20} />
				</button>
				<Kanban size={16} class="text-[var(--color-text-muted)]" />
				<span class="font-semibold text-sm">Board</span>
			</div>
		</div>
	{/if}
	{#if board.loading}
		<div class="flex-1 flex items-center justify-center text-[var(--color-text-muted)] text-sm">
			Loading board...
		</div>
	{:else}
		<div class="flex-1 flex gap-3 p-3 overflow-x-auto min-h-0">
			{#each board.columns as columnKey (columnKey)}
				{@const columnCards = board.cardsByColumn(columnKey)}
				<div
					class="flex flex-col min-w-[260px] max-w-[300px] w-[280px] shrink-0 rounded-lg bg-[var(--color-bg-surface)] border border-[var(--color-border)] {dragOverColumn === columnKey ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5' : ''}"
					ondragover={(e) => handleColumnDragOver(e, columnKey)}
					ondragleave={handleColumnDragLeave}
					ondrop={(e) => handleDrop(e, columnKey)}
					role="list"
				>
					<!-- Column header -->
					<div class="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
						<div class="flex items-center gap-2">
							<span class="text-sm font-semibold text-[var(--color-text)]">{COLUMN_LABELS[columnKey] ?? columnKey}</span>
							<span class="text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-hover)] rounded-full px-1.5 py-0.5">{columnCards.length}</span>
						</div>
					</div>

					<!-- Cards -->
					<div class="flex-1 overflow-y-auto p-2 space-y-2 min-h-[60px]">
						{#each columnCards as card (card.id)}
							<div
								class="group rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 cursor-grab active:cursor-grabbing hover:border-[var(--color-text-muted)]/30 transition-colors {draggingCardId === card.id ? 'opacity-40' : ''} {dragOverCardId === card.id ? 'border-[var(--color-accent)] border-t-2' : ''}"
								draggable="true"
								ondragstart={(e) => handleDragStart(e, card)}
								ondragend={handleDragEnd}
								ondragover={(e) => handleCardDragOver(e, card.id)}
								onclick={() => board.setEditingCard(card)}
								onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') board.setEditingCard(card); }}
								role="button"
								tabindex="0"
							>
								<div class="text-sm text-[var(--color-text)] font-medium mb-1.5">{card.title}</div>
								<div class="flex items-center gap-1.5 flex-wrap">
									<span class="text-[10px] px-1.5 py-0.5 rounded border {PRIORITY_COLORS[card.priority] ?? PRIORITY_COLORS['normal']}">{card.priority}</span>
									{#if card.assignee}
										<span class="text-[10px] text-[var(--color-text-muted)] truncate max-w-[120px]">{card.assignee}</span>
									{/if}
								</div>
								<!-- Delete button -->
								<button
									class="absolute top-1 right-1 p-0.5 rounded text-[var(--color-text-muted)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
									onclick={(e: MouseEvent) => { e.stopPropagation(); confirmDeleteId = card.id; }}
									title="Delete card"
								>
									<Trash size={12} />
								</button>
							</div>
						{/each}
					</div>

					<!-- Quick-add -->
					<div class="p-2 border-t border-[var(--color-border)]">
						<form
							onsubmit={(e) => { e.preventDefault(); handleQuickAdd(columnKey); }}
							class="flex items-center gap-1"
						>
							<input
								type="text"
								bind:value={quickAddInputs[columnKey]}
								placeholder="Add a card..."
								class="flex-1 text-sm bg-transparent border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:border-[var(--color-accent)]"
							/>
							<button
								type="submit"
								class="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
								title="Add card"
							>
								<Plus size={16} />
							</button>
						</form>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Edit card modal -->
{#if board.editingCard}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		onclick={() => board.setEditingCard(null)}
		onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') board.setEditingCard(null); }}
		role="button"
		tabindex="0"
	>
		<div
			class="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-xl w-full max-w-md mx-4 p-4"
			onclick={(e: MouseEvent) => { e.stopPropagation(); }}
			onkeydown={(e: KeyboardEvent) => { e.stopPropagation(); }}
			role="dialog"
			tabindex="-1"
		>
			<div class="flex items-center justify-between mb-4">
				<h3 class="text-lg font-semibold text-[var(--color-text)]">Edit Card</h3>
				<button
					onclick={() => board.setEditingCard(null)}
					class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
				>
					<X size={20} />
				</button>
			</div>

			<form
				onsubmit={(e) => { e.preventDefault(); handleEditSave(); }}
				class="space-y-3"
			>
				<div>
					<label for="edit-title" class="block text-xs text-[var(--color-text-muted)] mb-1">Title</label>
					<input
						id="edit-title"
						type="text"
						bind:value={editTitle}
						class="w-full text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
					/>
				</div>
				<div>
					<label for="edit-description" class="block text-xs text-[var(--color-text-muted)] mb-1">Description</label>
					<textarea
						id="edit-description"
						bind:value={editDescription}
						rows="3"
						class="w-full text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)] resize-none"
					></textarea>
				</div>
				<div class="flex gap-3">
					<div class="flex-1">
						<label for="edit-priority" class="block text-xs text-[var(--color-text-muted)] mb-1">Priority</label>
						<select
							id="edit-priority"
							bind:value={editPriority}
							class="w-full text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
						>
							<option value="urgent">Urgent</option>
							<option value="high">High</option>
							<option value="normal">Normal</option>
							<option value="low">Low</option>
						</select>
					</div>
					<div class="flex-1">
						<label for="edit-assignee" class="block text-xs text-[var(--color-text-muted)] mb-1">Assignee</label>
						<input
							id="edit-assignee"
							type="text"
							bind:value={editAssignee}
							placeholder="Username"
							class="w-full text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:border-[var(--color-accent)]"
						/>
					</div>
				</div>
				<div class="flex items-center justify-between pt-2">
					<button
						type="button"
						onclick={() => { confirmDeleteId = board.editingCard?.id ?? null; }}
						class="text-sm text-red-400 hover:text-red-300 transition-colors flex items-center gap-1"
					>
						<Trash size={14} />
						Delete
					</button>
					<div class="flex gap-2">
						<button
							type="button"
							onclick={() => board.setEditingCard(null)}
							class="text-sm px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
						>
							Cancel
						</button>
						<button
							type="submit"
							class="text-sm px-3 py-1.5 rounded bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
						>
							Save
						</button>
					</div>
				</div>
			</form>
		</div>
	</div>
{/if}

<!-- Delete confirmation modal -->
{#if confirmDeleteId}
	<div
		class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
		onclick={() => { confirmDeleteId = null; }}
		onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') confirmDeleteId = null; }}
		role="button"
		tabindex="0"
	>
		<div
			class="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-xl w-full max-w-sm mx-4 p-4"
			onclick={(e: MouseEvent) => { e.stopPropagation(); }}
			onkeydown={(e: KeyboardEvent) => { e.stopPropagation(); }}
			role="dialog"
			tabindex="-1"
		>
			<h3 class="text-lg font-semibold text-[var(--color-text)] mb-2">Delete Card</h3>
			<p class="text-sm text-[var(--color-text-muted)] mb-4">Are you sure you want to delete this card? This action cannot be undone.</p>
			<div class="flex justify-end gap-2">
				<button
					onclick={() => { confirmDeleteId = null; }}
					class="text-sm px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={() => { if (confirmDeleteId) handleDelete(confirmDeleteId); }}
					class="text-sm px-3 py-1.5 rounded bg-red-500 text-white hover:bg-red-600 transition-colors"
				>
					Delete
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Make card containers position relative for the absolute delete button */
	div[role="button"] {
		position: relative;
	}
</style>
