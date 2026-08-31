<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';
  import { todayDate } from '../lib/dates';

  const today = todayDate();
</script>

<Screen title="Dziś" lead="Plan posiłków na dzisiaj. Ekran powstanie w fazie 5.">
  <a class="text-sm font-medium text-(--color-accent) underline" href="#/day/{today}">
    Otwórz widok dnia ({today})
  </a>
</Screen>
