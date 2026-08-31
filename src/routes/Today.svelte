<script lang="ts">
  import DayScreen from '../lib/components/DayScreen.svelte';
  import { todayDate } from '../lib/dates';

  /**
   * `/` — today. The same screen as `/day/:date`, always pointed at the current day, which
   * makes today one tap away from anywhere via the „Kalendarz" nav item.
   *
   * The date is re-read whenever the tab becomes visible again, so an app left open
   * overnight does not keep showing yesterday (STATE.md decision 79).
   */

  let today = $state(todayDate());

  $effect(() => {
    const check = (): void => {
      if (document.visibilityState === 'visible') today = todayDate();
    };
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  });
</script>

<DayScreen date={today} {today} />
