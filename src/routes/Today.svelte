<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';

  // Local calendar date as YYYY-MM-DD (never UTC — a meal belongs to the day the
  // user is living in). Replaced by the shared date helpers in Phase 2.
  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
</script>

<Screen title="Dziś" lead="Plan posiłków na dzisiaj. Ekran powstanie w fazie 5.">
  <a class="text-sm font-medium text-(--color-accent) underline" href="#/day/{today}">
    Otwórz widok dnia ({today})
  </a>
</Screen>
