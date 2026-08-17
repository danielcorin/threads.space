<script lang="ts">
	const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

	let { class: className = '' }: { class?: string } = $props();

	let index = $state(0);

	$effect(() => {
		const id = setInterval(() => {
			index = (index + 1) % frames.length;
		}, 80);
		return () => clearInterval(id);
	});
</script>

<span class="inline-block w-[1ch] text-center {className}">{frames[index]}</span>
