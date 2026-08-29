<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';

  let { params }: { params?: Record<string, string | undefined> } = $props();
  const date = $derived(params?.date ?? '—');
  const mealId = $derived(params?.mealId ?? '—');
</script>

<Screen title="Posiłek" lead="Szczegóły posiłku i przeliczanie porcji. Ekran powstanie w fazie 5.">
  <p class="text-sm">Data: <span class="font-medium">{date}</span></p>
  <p class="text-sm">Identyfikator posiłku: <span class="font-medium">{mealId}</span></p>
</Screen>
