<script lang="ts">
  import type { Snippet } from 'svelte';
  import BottomNav from './BottomNav.svelte';
  import Sidebar from './Sidebar.svelte';
  import SyncIndicator from './SyncIndicator.svelte';

  let { children }: { children: Snippet } = $props();
</script>

<!--
  One layout, two containers. Both navigations are always in the DOM and are
  swapped by a CSS media query, so resizing the window switches between them
  without a reload or a JS listener.
-->
<div class="min-h-dvh md:pl-56">
  <Sidebar />
  <div class="mx-auto w-full max-w-3xl">
    <SyncIndicator />
  </div>
  <!--
    The bottom padding is what keeps the last card above BottomNav: `--nav-h` plus the gap
    that `pb-24` used to include, so at a zero inset this is the same 6rem it always was.
  -->
  <main
    class="mx-auto w-full max-w-3xl pt-4 pr-[max(1rem,var(--safe-right))] pb-[calc(var(--nav-h)+2.1875rem)] pl-[max(1rem,var(--safe-left))] md:pb-8"
  >
    {@render children()}
  </main>
  <BottomNav />
</div>
