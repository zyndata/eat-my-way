<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';

  let { params }: { params?: Record<string, string | undefined> } = $props();
  const date = $derived(params?.date ?? '—');
</script>

<Screen title="Dzień" lead="Posiłki i podsumowanie makroskładników. Ekran powstanie w fazie 5.">
  <p class="text-sm">Data: <span class="font-medium">{date}</span></p>
  <a class="text-sm font-medium text-(--color-accent) underline" href="#/day/{date}/przyklad">
    Otwórz przykładowy posiłek
  </a>
</Screen>
