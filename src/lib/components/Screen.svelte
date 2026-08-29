<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    lead,
    children
  }: { title: string; lead?: string; children?: Snippet } = $props();
</script>

<section>
  <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
  {#if lead}
    <p class="pt-1 text-sm text-(--color-ink-muted)">{lead}</p>
  {/if}
  {#if children}
    <div class="pt-4">{@render children()}</div>
  {/if}
</section>
