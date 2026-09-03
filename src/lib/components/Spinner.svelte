<script lang="ts">
  /**
   * A busy indicator for work with no percentage to report (PLAN.md Phase 11 task 3).
   *
   * Two rules it must not break. It animates from `.emw-spinner` in the bundled stylesheet and
   * never from an inline `style`, because the production CSP has no `'unsafe-inline'` for
   * styles (STATE.md decision 71) — the same rule that already makes every bar in this app SVG
   * geometry. And it is `aria-hidden`, so a `role="status"` line beside it is announced once
   * rather than twice: the words are the message, this is only the sign that they are current.
   *
   * The colour is `currentColor`, so it belongs to whatever it sits inside — the accent ink on
   * a filled button, the muted ink in a status line.
   */

  let { class: className = 'size-4' }: { class?: string } = $props();
</script>

<span class="emw-spinner {className}" aria-hidden="true"></span>
