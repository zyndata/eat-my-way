import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { startPwa } from './lib/pwa.svelte';
import { startTheme } from './lib/theme.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Mount target #app is missing from index.html');

// The first thing that runs. The production CSP allows no inline bootstrap script, so this is
// the earliest point anything of ours can put the theme on the document — and it reads the
// `localStorage` mirror synchronously, because an IndexedDB round trip would land after the
// first paint (STATE.md decision 195).
startTheme();

// Before the mount on purpose: `beforeinstallprompt` fires early and the browser does not
// replay it for a listener that arrives late.
startPwa();

export default mount(App, { target });
