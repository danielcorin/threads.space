<script lang="ts">
	// Circular spinner. Uses the current text color (border-current) so it
	// inherits the button/text color it's placed in. Size via the class prop
	// (defaults to 1em square so it matches the surrounding font size).
	let { class: className = 'w-[1em] h-[1em]' }: { class?: string } = $props();
</script>

<span
	role="status"
	aria-label="Loading"
	class="inline-block rounded-full border-2 border-current border-t-transparent animate-spin {className}"
></span>
