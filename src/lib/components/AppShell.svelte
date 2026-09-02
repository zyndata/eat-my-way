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
  <main class="mx-auto w-full max-w-3xl px-4 pt-4 pb-24 md:pb-8">
    {@render children()}
  </main>
  <BottomNav />
</div>
