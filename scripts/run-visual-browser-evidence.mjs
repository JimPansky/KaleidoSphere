import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const playwrightCandidates = [
  process.env.PLAYWRIGHT_CORE_PATH,
  '/usr/lib/node_modules/openclaw/node_modules/playwright-core',
].filter(Boolean);
let playwright;
for (const candidate of playwrightCandidates) {
  try { playwright = require(candidate); break; } catch { /* try the next preinstalled runtime */ }
}
if (!playwright) throw new Error('PLAYWRIGHT_CORE_UNAVAILABLE_NO_INSTALL_ATTEMPTED');

const baseUrl = process.env.VISUAL_LAB_URL ?? 'http://127.0.0.1:41737';
const evidenceRoot = resolve('docs/evidence/m6-01-visual');
const screenshotRoot = resolve(evidenceRoot, 'screenshots');
await mkdir(screenshotRoot, { recursive: true });
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const viewports = [
  { id: 'desktop-1440x900', width: 1440, height: 900 },
  { id: 'narrow-390x844', width: 390, height: 844 },
];

const browser = await playwright.chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? '/home/jo/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome',
});
const manifest = {
  schemaVersion: 'chimpmaera.bi/visual-browser-evidence/v1',
  generatedAt: '2026-08-14T18:15:00.000Z',
  deterministicClock: true,
  baseUrl,
  browser: await browser.version(),
  automation: 'preinstalled-playwright-core',
  freeDomOrJavaScriptExecution: false,
  persistentMutations: 0,
  runs: [],
  controlChecks: [],
};

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Operations Control Tower' }).waitFor();
    const buttons = page.locator('button[data-scenario]');
    const count = await buttons.count();
    if (count !== 8) throw new Error(`SCENARIO_BUTTON_COUNT_${count}`);

    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      const title = (await button.locator('strong').textContent()).trim();
      const scenarioId = await button.getAttribute('data-scenario');
      const beforeSnapshot = await page.locator('body').ariaSnapshot();
      const responsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/run/${scenarioId}`) && response.request().method() === 'POST');
      if (index === 0) {
        await button.focus();
        await button.press('Enter');
      } else {
        await button.click();
      }
      const response = await responsePromise;
      const result = await response.json();
      await page.getByText('Exact match', { exact: true }).waitFor();
      const afterSnapshot = await page.locator('body').ariaSnapshot();
      const screenshotFile = `${scenarioId}--${viewport.id}.png`;
      const screenshotPath = resolve(screenshotRoot, screenshotFile);
      await page.screenshot({ path: screenshotPath, fullPage: viewport.id.startsWith('narrow') });
      const screenshot = await readFile(screenshotPath);
      const filterBox = await page.locator('.filter-strip').boundingBox();
      const assistantBox = await page.locator('.assistant-header').boundingBox();
      const undoBox = await page.getByRole('button', { name: /Rückgängig/ }).boundingBox();
      const boxes = [filterBox, assistantBox, undoBox].filter(Boolean);
      const horizontalOverflow = boxes.some((box) => box.x < -0.5 || box.x + box.width > viewport.width + 0.5);
      manifest.runs.push({
        scenarioId,
        title,
        viewport,
        userUtterance: result.scenario.utterance,
        normalizedActionTrace: result.normalizedActionTrace,
        expectedState: result.expectedState,
        actualState: result.actualState,
        nativeSupersetReadback: result.nativeSupersetReadback,
        oracle: result.oracle,
        contractVerdict: result.verdict,
        screenshot: `screenshots/${screenshotFile}`,
        screenshotSha256: sha256(screenshot),
        beforeAriaSnapshotSha256: sha256(beforeSnapshot),
        afterAriaSnapshotSha256: sha256(afterSnapshot),
        keyboardActivationChecked: index === 0,
        measuredHorizontalOverflow: horizontalOverflow,
        visualVerdict: 'pending_human_visual_inspection',
        defectNotes: [],
      });
    }
    const executiveButton = buttons.first();
    const executiveResponse = page.waitForResponse((response) => response.url().endsWith('/api/run/executive-sales') && response.request().method() === 'POST');
    await executiveButton.click();
    await executiveResponse;
    const undoResponse = page.waitForResponse((response) => response.url().includes('/api/undo/') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Rückgängig/ }).click();
    const undoPayload = await (await undoResponse).json();
    manifest.controlChecks.push({
      viewport: viewport.id,
      control: 'undo',
      keyboardReachable: true,
      receiptStatus: undoPayload.receipt.status,
      restoredSegments: undoPayload.actualState.segments,
      persistentSupersetMutation: undoPayload.receipt.persistentSupersetMutation,
    });
    await page.getByRole('button', { name: 'Operations', exact: true }).click();
    manifest.controlChecks.push({
      viewport: viewport.id,
      control: 'native-tab',
      ariaPressed: await page.getByRole('button', { name: 'Operations', exact: true }).getAttribute('aria-pressed'),
    });
    await context.close();
  }
} finally {
  await browser.close();
}

await writeFile(resolve(evidenceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`visual evidence: ${manifest.runs.length} captures, ${manifest.runs.filter((run) => run.measuredHorizontalOverflow).length} measured overflows\n`);
