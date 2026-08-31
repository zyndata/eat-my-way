<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Circular progress, drawn entirely with SVG *presentation attributes*
   * (`stroke-dasharray`, `stroke-dashoffset`). No inline style anywhere — the production CSP
   * is `style-src 'self'` and would block one. See STATE.md decision 71.
   *
   * The colour comes from `currentColor`, so a parent's text colour drives the arc.
   */

  let {
    ratio,
    over = false,
    label,
    children
  }: {
    /** 0…1. Already clamped by `goalRatio`. */
    ratio: number;
    /** The goal has been passed — the arc is full and changes colour. */
    over?: boolean;
    /** Accessible description; the ring itself is decorative without it. */
    label?: string;
    /** Rendered in the middle of the ring, usually the day number. */
    children?: Snippet;
  } = $props();

  const RADIUS = 15.5;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  const offset = $derived(CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, ratio))));
</script>

<span class="relative grid size-10 place-items-center">
  <svg
    class="absolute inset-0 size-10 {over ? 'text-amber-600' : 'text-(--color-accent)'}"
    viewBox="0 0 36 36"
    role={label ? 'img' : 'presentation'}
    aria-label={label}
    aria-hidden={label ? undefined : 'true'}
  >
    <circle
      cx="18"
      cy="18"
      r={RADIUS}
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      class="text-(--color-border)"
    />
    {#if ratio > 0}
      <circle
        cx="18"
        cy="18"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-dasharray={CIRCUMFERENCE}
        stroke-dashoffset={offset}
        transform="rotate(-90 18 18)"
      />
    {/if}
  </svg>
  {#if children}
    <span class="relative text-sm leading-none">{@render children()}</span>
  {/if}
</span>
