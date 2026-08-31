<script lang="ts">
  import DayScreen from '../lib/components/DayScreen.svelte';
  import { todayDate } from '../lib/dates';

  /** `/day/:date` — any day. Same screen as `/`, with the date coming from the route. */

  let { params }: { params?: Record<string, string | undefined> } = $props();

  const today = todayDate();
  const date = $derived(params?.date ?? today);
</script>

<DayScreen {date} {today} />
