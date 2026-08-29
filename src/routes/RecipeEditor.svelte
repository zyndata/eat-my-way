<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';

  let { params }: { params?: Record<string, string | undefined> } = $props();
  const id = $derived(params?.id ?? '—');
</script>

<Screen title="Edytor przepisu" lead="Składniki, makroskładniki i instrukcje. Ekran powstanie w fazie 4.">
  <p class="text-sm">Identyfikator przepisu: <span class="font-medium">{id}</span></p>
</Screen>
