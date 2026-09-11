<script lang="ts">
  import { router } from 'svelte-spa-router';
  import { navItems, isActive } from '../nav';
  import NavIcon from './NavIcon.svelte';
</script>

<!--
  Mobile navigation. Hidden from md up, where Sidebar takes over.

  The bar pads itself with the bottom inset and, on top of that, takes its height from
  `--nav-h` — the same token every element that has to clear it reads. If the padding and the
  icons ever add up to something else, the bar is the thing that gives way, so the token stays
  true and nothing ends up behind the bar (Phase 15).
-->
<nav
  class="fixed inset-x-0 bottom-0 z-20 min-h-(--nav-h) border-t border-(--color-border) bg-(--color-surface-raised) pr-(--safe-right) pb-(--safe-bottom) pl-(--safe-left) md:hidden"
  aria-label="Nawigacja główna"
>
  <ul class="flex">
    {#each navItems as item (item.href)}
      {@const active = isActive(router.location, item)}
      <li class="flex-1">
        <a
          href={item.href}
          class="flex flex-col items-center gap-1 py-2 text-xs font-medium transition-colors {active
            ? 'text-(--color-accent)'
            : 'text-(--color-ink-muted)'}"
          aria-current={active ? 'page' : undefined}
        >
          <NavIcon path={item.icon} class="size-6" />
          {item.label}
        </a>
      </li>
    {/each}
  </ul>
</nav>
