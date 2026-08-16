import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const candidates = [process.env.PLAYWRIGHT_CORE_PATH, '/usr/lib/node_modules/openclaw/node_modules/playwright-core'].filter(Boolean);
let playwright;
for (const candidate of candidates) {
  try { playwright = require(candidate); break; } catch { /* use only an already-installed browser runtime */ }
}
if (!playwright) throw new Error('PLAYWRIGHT_CORE_UNAVAILABLE_NO_INSTALL_ATTEMPTED');

const nativeEvidencePath = resolve(process.env.NATIVE_EVIDENCE_MANIFEST ?? 'docs/evidence/m6-02-native/live-manifest.json');
const evidenceRoot = resolve(process.env.NATIVE_VISUAL_EVIDENCE_ROOT ?? 'docs/evidence/m6-02-native-visual');
const screenshotRoot = resolve(evidenceRoot, 'screenshots');
const passwordPath = resolve(process.env.SUPERSET_ADMIN_PASSWORD_FILE ?? '.runtime/secrets/superset_admin_password');
const nativeEvidence = JSON.parse(await readFile(nativeEvidencePath, 'utf8'));
const password = (await readFile(passwordPath, 'utf8')).trim();
if (!password || nativeEvidence.consecutiveFullGreenRuns !== 2 || nativeEvidence.runs?.length !== 2) throw new Error('NATIVE_VISUAL_PRECONDITION_FAILED');
const liveRun = nativeEvidence.runs.at(-1);
if (!liveRun.allPassed || liveRun.scenarios.length !== 8) throw new Error('NATIVE_VISUAL_LIVE_RUN_INVALID');
const baseUrl = new URL(nativeEvidence.runtime.baseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname)) throw new Error('NATIVE_VISUAL_TARGET_DENIED');
const cacheSettleMinimumMs = Number(process.env.NATIVE_ASSET_CACHE_SETTLE_MS ?? 22_000);
const evidenceGeneratedAtMs = Date.parse(nativeEvidence.generatedAt);
if (!Number.isInteger(cacheSettleMinimumMs) || cacheSettleMinimumMs < 0 || cacheSettleMinimumMs > 30_000 || Number.isNaN(evidenceGeneratedAtMs)) {
  throw new Error('NATIVE_CACHE_SETTLE_POLICY_INVALID');
}
const cacheSettleWaitMs = Math.max(0, cacheSettleMinimumMs - (Date.now() - evidenceGeneratedAtMs));
if (cacheSettleWaitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, cacheSettleWaitMs));
const cacheSettleAgeMs = Date.now() - evidenceGeneratedAtMs;
if (cacheSettleAgeMs < cacheSettleMinimumMs) throw new Error('NATIVE_CACHE_SETTLE_PRECONDITION_FAILED');

await mkdir(screenshotRoot, { recursive: true });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const classifyConsoleError = (text) => (
  text.includes('service-worker.js') && text.includes('404')
    ? 'known_superset_service_worker_404'
    : text === 'A bad HTTP response code (404) was received when fetching the script.'
      ? 'known_superset_service_worker_404'
      : 'unexpected'
);
const nativeEvidenceBytes = await readFile(nativeEvidencePath);
const viewports = [
  { id: 'desktop-1440x900', width: 1440, height: 900, fullPage: true },
  { id: 'narrow-390x844', width: 390, height: 844, fullPage: true },
];
const browser = await playwright.chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? '/home/jo/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome',
});
const manifest = {
  schemaVersion: 'chimpmaera.bi/native-superset-browser-evidence/v1',
  generatedAt: new Date().toISOString(),
  nativeEvidenceManifest: 'docs/evidence/m6-02-native/live-manifest.json',
  nativeEvidenceManifestSha256: sha256(nativeEvidenceBytes),
  nativeRunId: liveRun.runId,
  baseUrl: baseUrl.origin,
  browser: await browser.version(),
  automation: 'preinstalled-playwright-core-role-and-label-locators',
  freeDomOrInjectedJavaScriptActions: 0,
  persistentDashboardMutations: 0,
  cacheStability: {
    nativeEvidenceGeneratedAt: nativeEvidence.generatedAt,
    minimumAssetAgeMs: cacheSettleMinimumMs,
    waitAppliedMs: cacheSettleWaitMs,
    observedAssetAgeMs: cacheSettleAgeMs,
    stalePostProvisionCaptureFailsClosed: true,
  },
  consoleErrorPolicy: {
    allowedClasses: ['known_superset_service_worker_404'],
    rawConsoleMessagesPersisted: false,
    unexpectedErrorsFailClosed: true,
  },
  captures: [],
};

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' });
    const loginPage = await context.newPage();
    await loginPage.goto(`${baseUrl.origin}/login/`, { waitUntil: 'domcontentloaded' });
    await loginPage.getByLabel('Username').fill('cm_admin');
    await loginPage.getByLabel('Password').fill(password);
    await Promise.all([
      loginPage.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
      loginPage.getByRole('button', { name: /sign in/i }).click(),
    ]);
    await loginPage.close();

    for (const scenario of liveRun.scenarios) {
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      const expectedCharts = [...(nativeEvidence.stableAssets.dashboardCharts?.[scenario.dashboard.uuid] ?? [])]
        .sort((left, right) => left.id - right.id);
      if (expectedCharts.length !== scenario.chartTypes.length) throw new Error(`NATIVE_CHART_ASSOCIATION_MISMATCH:${scenario.scenarioId}`);
      const chartPayloads = [];
      const onResponse = async (response) => {
        if (!response.url().includes('/api/v1/chart/data') || response.request().method() !== 'POST') return;
        let body;
        try { body = await response.json(); } catch { body = null; }
        chartPayloads.push({ ok: response.ok(), body });
      };
      page.on('response', onResponse);
      await page.goto(`${baseUrl.origin}/superset/dashboard/${scenario.dashboard.uuid}/?standalone=3&show_filters=0&expand_filters=0`, { waitUntil: 'domcontentloaded' });
      const firstChartLabel = expectedCharts[0].title.split(' · ').at(-1);
      const firstChartTitle = page.getByText(new RegExp(`${escapeRegex(firstChartLabel)}$`, 'i')).first();
      await firstChartTitle.waitFor({ state: 'visible', timeout: 30_000 });
      for (let attempt = 0; attempt < 30 && chartPayloads.length < expectedCharts.length; attempt += 1) {
        await page.mouse.wheel(0, Math.floor(viewport.height * 0.8));
        await page.waitForTimeout(500);
      }
      page.off('response', onResponse);
      if (chartPayloads.length < expectedCharts.length) {
        await page.screenshot({ path: `/tmp/m6-02-native-timeout-${scenario.scenarioId}-${viewport.id}.png`, fullPage: true });
        throw new Error(`NATIVE_CHART_RESPONSE_TIMEOUT:${scenario.scenarioId}:${chartPayloads.length}/${expectedCharts.length}`);
      }
      await page.mouse.wheel(-100_000, -100_000);
      await page.waitForTimeout(1_000);
      const dashboardHeader = page.getByText(new RegExp(`^${escapeRegex(scenario.dashboard.title)}`, 'i')).first();
      await dashboardHeader.waitFor({ state: 'visible', timeout: 10_000 });
      const dashboardHeaderBounds = await dashboardHeader.boundingBox();
      if (!dashboardHeaderBounds || dashboardHeaderBounds.x < 0
        || dashboardHeaderBounds.x + dashboardHeaderBounds.width > viewport.width) {
        throw new Error(`NATIVE_DASHBOARD_BOUNDS_INVALID:${scenario.scenarioId}:${viewport.id}`);
      }
      const failedChartResponses = chartPayloads.filter(({ ok, body }) => !ok || !body || body.errors?.length > 0 || body.message || body.result?.some((item) => item.error || item.status === 'failed')).length;
      if (failedChartResponses > 0) throw new Error(`NATIVE_CHART_QUERY_FAILED:${scenario.scenarioId}:${failedChartResponses}`);
      for (const chart of expectedCharts) {
        const label = chart.title.split(' · ').at(-1);
        if (await page.getByText(new RegExp(`${escapeRegex(label)}$`, 'i')).count() === 0) throw new Error(`NATIVE_CHART_TITLE_MISSING:${scenario.scenarioId}:${chart.uuid}`);
      }
      const waiting = page.getByText(/Waiting on ChimpMaera BI managed projection/i);
      if (await waiting.count() > 0) await waiting.last().waitFor({ state: 'hidden', timeout: 10_000 });
      const chartCount = expectedCharts.length;
      const visibleErrors = await page.getByText(/data error|unexpected error|failed to load|query timeout/i).count();
      if (visibleErrors > 0) throw new Error(`NATIVE_DASHBOARD_VISIBLE_ERROR:${scenario.scenarioId}`);
      const screenshotFile = `${scenario.scenarioId}--${viewport.id}.png`;
      const screenshotPath = resolve(screenshotRoot, screenshotFile);
      await page.screenshot({ path: screenshotPath, fullPage: viewport.fullPage, animations: 'disabled' });
      const screenshot = await readFile(screenshotPath);
      const horizontalOverflow = screenshot.readUInt32BE(16) !== viewport.width;
      const captureConsoleErrors = consoleErrors.map(classifyConsoleError);
      manifest.captures.push({
        captureId: `${liveRun.runId}:${scenario.scenarioId}:${viewport.id}`,
        capturedAt: new Date().toISOString(),
        scenarioId: scenario.scenarioId,
        viewport: { id: viewport.id, width: viewport.width, height: viewport.height },
        dashboard: scenario.dashboard,
        permalinkKey: scenario.nativeSupersetReadback.permalinkKey,
        screenshotNavigationMode: 'direct_stable_uuid_standalone_public_view_after_independent_permalink_readback',
        nativeReadbackMode: scenario.nativeSupersetReadback.mode,
        nativeReadbackDigest: scenario.nativeSupersetReadback.rawPermalinkStateDigest,
        expectedState: scenario.expectedState,
        actualState: scenario.actualState,
        oracle: scenario.oracle,
        actionTrace: scenario.trace,
        denialCount: scenario.denialCount,
        unsupportedActionDenialCount: scenario.unsupportedActionDenialCount,
        mutationCounts: scenario.mutationCounts,
        layoutId: scenario.layoutId,
        chartTypes: scenario.chartTypes,
        viewSignature: scenario.viewSignature,
        rationale: scenario.rationale,
        renderedChartCount: chartCount,
        dashboardHeaderBounds: {
          x: Math.round(dashboardHeaderBounds.x), y: Math.round(dashboardHeaderBounds.y),
          width: Math.round(dashboardHeaderBounds.width), height: Math.round(dashboardHeaderBounds.height),
        },
        screenshot: `screenshots/${screenshotFile}`,
        screenshotSha256: sha256(screenshot),
        measuredHorizontalOverflow: horizontalOverflow,
        consoleErrorCount: captureConsoleErrors.length,
        allowedConsoleErrorCount: captureConsoleErrors.filter((kind) => kind !== 'unexpected').length,
        unexpectedConsoleErrorCount: captureConsoleErrors.filter((kind) => kind === 'unexpected').length,
        consoleErrorClasses: [...new Set(captureConsoleErrors)],
        pageErrorCount: pageErrors.length,
        visualVerdict: 'pending_direct_pixel_review',
        defectNotes: [],
      });
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
}

if (manifest.captures.length !== 16) throw new Error(`NATIVE_CAPTURE_COUNT_${manifest.captures.length}`);
manifest.responsiveEvidence = {
  desktopCaptures: manifest.captures.filter((capture) => capture.viewport.id.startsWith('desktop')).length,
  narrowCaptures: manifest.captures.filter((capture) => capture.viewport.id.startsWith('narrow')).length,
  strategy: 'native_superset_grid_recomposes_cards_and_filters_for_narrow_viewport',
  scaleOnly: false,
};
await writeFile(resolve(evidenceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
if (manifest.captures.some((capture) => capture.measuredHorizontalOverflow || capture.pageErrorCount > 0 || capture.unexpectedConsoleErrorCount > 0)) throw new Error('NATIVE_BROWSER_RENDER_GATE_FAILED');
process.stdout.write(`native Superset visual evidence: ${manifest.captures.length} captures, ${manifest.captures.filter((capture) => capture.measuredHorizontalOverflow).length} measured overflows\n`);
