<script lang="ts">
  import { Separator } from 'bits-ui';
  import { router } from 'svelte-spa-router';
  import { navItems, isActive } from '../nav';
  import NavIcon from './NavIcon.svelte';
</script>

<!-- Desktop navigation. Hidden below md, where BottomNav takes over. -->
<nav
  class="fixed inset-y-0 left-0 z-20 hidden w-56 shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface-raised) px-3 py-4 md:flex"
  aria-label="Nawigacja główna"
>
  <a href="#/" class="px-2 text-lg font-semibold tracking-tight">Eat My Way</a>
  <p class="px-2 pt-0.5 pb-3 text-xs text-(--color-ink-muted)">Plan posiłków</p>

  <Separator.Root class="mb-3 h-px bg-(--color-border)" />

  <ul class="flex flex-col gap-1">
    {#each navItems as item (item.href)}
      {@const active = isActive(router.location, item)}
      <li>
        <a
          href={item.href}
          class="flex items-center gap-3 rounded-lg px-2 py-2 text-sm font-medium transition-colors {active
            ? 'bg-(--color-accent) text-(--color-accent-ink)'
            : 'text-(--color-ink-muted) hover:bg-(--color-surface)'}"
          aria-current={active ? 'page' : undefined}
        >
          <NavIcon path={item.icon} class="size-5" />
          {item.label}
        </a>
      </li>
    {/each}
  </ul>
</nav>
