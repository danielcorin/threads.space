/**
 * Svelte action that moves a node to a target element (default: document.body)
 * for the duration of its lifetime, then returns it to its original position
 * on destroy. Use to escape ancestor stacking contexts / overflow clipping
 * for popovers, tooltips, modals, etc.
 */
export function portal(node: HTMLElement, target: HTMLElement | string = document.body) {
	function resolveTarget(t: HTMLElement | string): HTMLElement {
		if (typeof t === 'string') {
			const el = document.querySelector(t);
			if (!(el instanceof HTMLElement)) {
				throw new Error(`portal: target "${t}" not found`);
			}
			return el;
		}
		return t;
	}

	let dest = resolveTarget(target);
	dest.appendChild(node);

	return {
		update(newTarget: HTMLElement | string) {
			const next = resolveTarget(newTarget);
			if (next !== dest) {
				dest = next;
				dest.appendChild(node);
			}
		},
		destroy() {
			node.parentNode?.removeChild(node);
		}
	};
}
