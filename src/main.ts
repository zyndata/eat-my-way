import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { startPwa } from './lib/pwa.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Mount target #app is missing from index.html');

// Before the mount on purpose: `beforeinstallprompt` fires early and the browser does not
// replay it for a listener that arrives late.
startPwa();

export default mount(App, { target });
