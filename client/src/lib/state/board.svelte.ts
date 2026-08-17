import { api } from '$lib/api.js';

export interface KanbanCard {
	id: string;
	board_id: string;
	column_key: string;
	title: string;
	description: string | null;
	assignee: string | null;
	priority: string;
	position: number;
	source_message_id: string | null;
	metadata: string | null;
	created_by: string;
	created_at: string;
	updated_at: string | null;
}

export interface KanbanBoard {
	id: string;
	channel_id: string;
	columns: string;
	created_by: string;
	created_at: string;
}

const DEFAULT_COLUMNS = ['todo', 'in-progress', 'review', 'done'];

let _board = $state<KanbanBoard | null>(null);
let _cards = $state<KanbanCard[]>([]);
let _loading = $state(false);
let _editingCard = $state<KanbanCard | null>(null);
let _channelId = $state<string | null>(null);

export const board = {
	get data() {
		return _board;
	},
	get cards() {
		return _cards;
	},
	get loading() {
		return _loading;
	},
	get editingCard() {
		return _editingCard;
	},
	get channelId() {
		return _channelId;
	},
	get columns(): string[] {
		if (_board?.columns) {
			try {
				return JSON.parse(_board.columns);
			} catch {
				return DEFAULT_COLUMNS;
			}
		}
		return DEFAULT_COLUMNS;
	},

	setEditingCard(card: KanbanCard | null) {
		_editingCard = card;
	},

	cardsByColumn(columnKey: string): KanbanCard[] {
		return _cards
			.filter((c) => c.column_key === columnKey)
			.sort((a, b) => a.position - b.position);
	},

	async loadBoard(channelId: string) {
		_channelId = channelId;
		_loading = true;
		try {
			const result = await api.boards.get(channelId);
			_board = result.board;
			_cards = result.cards;
		} catch (err: any) {
			if (err.message?.includes('404') || err.message?.includes('not found')) {
				// Board doesn't exist yet, create one
				try {
					const newBoard = await api.boards.create(channelId);
					_board = newBoard;
					_cards = [];
				} catch {
					_board = null;
					_cards = [];
				}
			} else {
				_board = null;
				_cards = [];
			}
		} finally {
			_loading = false;
		}
	},

	async createCard(channelId: string, data: { title: string; description?: string; assignee?: string; priority?: string; column_key?: string }) {
		const card = await api.boards.createCard(channelId, data);
		_cards = [..._cards, card];
		return card;
	},

	async updateCard(cardId: string, data: { title?: string; description?: string; column_key?: string; assignee?: string | null; priority?: string; position?: number }) {
		const updated = await api.boards.updateCard(cardId, data);
		_cards = _cards.map((c) => (c.id === cardId ? updated : c));
		if (_editingCard?.id === cardId) {
			_editingCard = updated;
		}
		return updated;
	},

	async deleteCard(cardId: string) {
		await api.boards.deleteCard(cardId);
		_cards = _cards.filter((c) => c.id !== cardId);
		if (_editingCard?.id === cardId) {
			_editingCard = null;
		}
	},

	async moveCard(cardId: string, columnKey: string, position: number) {
		// Optimistic update
		_cards = _cards.map((c) =>
			c.id === cardId ? { ...c, column_key: columnKey, position } : c
		);
		try {
			const updated = await api.boards.updateCard(cardId, { column_key: columnKey, position });
			_cards = _cards.map((c) => (c.id === cardId ? updated : c));
		} catch {
			// Revert on failure by reloading
			if (_channelId) await this.loadBoard(_channelId);
		}
	},

	// WebSocket event handlers
	handleCardCreated(card: KanbanCard) {
		if (!_cards.find((c) => c.id === card.id)) {
			_cards = [..._cards, card];
		}
	},

	handleCardUpdated(card: KanbanCard) {
		_cards = _cards.map((c) => (c.id === card.id ? card : c));
		if (_editingCard?.id === card.id) {
			_editingCard = card;
		}
	},

	handleCardDeleted(cardId: string) {
		_cards = _cards.filter((c) => c.id !== cardId);
		if (_editingCard?.id === cardId) {
			_editingCard = null;
		}
	},

	handleBoardUpdated(boardData: KanbanBoard) {
		_board = boardData;
	},

	clear() {
		_board = null;
		_cards = [];
		_loading = false;
		_editingCard = null;
		_channelId = null;
	}
};
