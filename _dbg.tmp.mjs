import { chromium } from '@playwright/test';

const waitControlled = (page) => page.waitForFunction(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return r?.active != null && navigator.serviceWorker.controller !== null;
}, undefined, { timeout: 30000 });

async function controlledGoto(page, base, path) {
  await page.goto(base + path);
  await waitControlled(page);
  return page.reload();
}

async function probe(base, round) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  await page.goto(base + '/');
  await waitControlled(page);

  const out = {};
  for (const path of ['/sciezka-ktorej-nie-ma', '/polaczenie']) {
    const r = await controlledGoto(page, base, path);
    out[path] = { status: r?.status(), fromSW: r?.fromServiceWorker() };
  }
  await browser.close();
  console.log(base, 'round', round, JSON.stringify(out));
}

for (let i = 1; i <= 3; i += 1) {
  for (const base of ['http://localhost:4173', 'http://localhost:8080']) await probe(base, i);
}
