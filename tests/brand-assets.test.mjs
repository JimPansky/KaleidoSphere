import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const assetRoot = path.join(root, 'services/bi-agent/assets');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pngDimensions(value) {
  assert(value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal(value.subarray(12, 16).toString('ascii'), 'IHDR');
  return {width: value.readUInt32BE(16), height: value.readUInt32BE(20)};
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const {port} = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function rawRequest(port, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({host: '127.0.0.1', port, path: requestPath, method}, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)}));
    });
    request.once('error', reject);
    request.end();
  });
}

async function waitForServer(port, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`brand test server exited ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('brand test server did not become ready');
}

test('brand asset manifest binds approved source, exact bytes, MIME types and dimensions', async () => {
  const manifest = JSON.parse(await readFile(path.join(assetRoot, 'brand-assets.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 'kaleidosphere.brand-assets/v1');
  assert.equal(manifest.source.path, 'kaleidosphere-logo.png');
  assert.equal(manifest.source.sha256, 'b8cba4a7765488e90c71562b16a749a0ee4a9d17cdac5345acbdf5b77232dccd');
  assert.deepEqual(manifest.assets.map(({route}) => route), [
    '/assets/kaleidosphere-logo.svg',
    '/assets/kaleidosphere-logo.png',
    '/assets/favicon-16x16.png',
    '/assets/favicon-32x32.png',
    '/assets/apple-touch-icon.png',
    '/assets/icon-192.png',
    '/assets/icon-512.png',
  ]);

  for (const asset of manifest.assets) {
    const value = await readFile(path.join(assetRoot, asset.path));
    assert(value.length > 0, asset.path);
    assert.equal(sha256(value), asset.sha256, asset.path);
    if (asset.mimeType === 'image/png') {
      assert.deepEqual(pngDimensions(value), {width: asset.width, height: asset.height}, asset.path);
    }
  }

  const svg = await readFile(path.join(assetRoot, 'kaleidosphere-logo.svg'), 'utf8');
  assert.match(svg, /^<svg[^>]+width="1254"[^>]+height="1254"[^>]+viewBox="0 0 1254 1254"/);
  assert.match(svg, /<title>KaleidoSphere Variant C transparent<\/title>/);
  assert.match(svg, /href="data:image\/png;base64,/);
  assert.doesNotMatch(svg, /<script|javascript:|(?:href|src)=["']https?:\/\//i);
});

test('README, web manifest and container reference the complete pragmatic icon set', async () => {
  const [readme, webManifest, dockerfile] = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(assetRoot, 'site.webmanifest'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'services/bi-agent/Dockerfile'), 'utf8'),
  ]);
  assert.match(readme, /<source srcset="services\/bi-agent\/assets\/kaleidosphere-logo\.svg" type="image\/svg\+xml">/);
  assert.match(readme, /<img src="services\/bi-agent\/assets\/kaleidosphere-logo\.png" alt="KaleidoSphere logo" width="280" height="280">/);
  assert.deepEqual(webManifest.icons, [
    {src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any'},
    {src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any'},
  ]);
  assert.equal(webManifest.start_url, '/');
  assert.equal(webManifest.scope, '/');
  assert.match(dockerfile, /^COPY --chown=10001:10001 assets \.\/assets$/m);
  assert.match(dockerfile, /^USER 10001:10001$/m);
});

test('README provenance stays product-neutral while linking exact source maps', async () => {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const provenance = readme.slice(readme.indexOf('## Provenance'));
  const legacyProductName = ['Chimp', 'Maera'].join('');

  assert.match(provenance, /external public source\s+material/);
  assert.match(provenance, /\[SOURCE-MAP\.md\]\(SOURCE-MAP\.md\)/);
  assert.match(provenance, /\[SOURCE-MAP\.json\]\(SOURCE-MAP\.json\)/);
  assert.doesNotMatch(provenance, new RegExp(legacyProductName, 'i'));
});

test('BI-agent serves exact brand bytes and denies unknown, traversal-shaped and wrong-method routes', async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ['services/bi-agent/src/server.mjs'], {
    cwd: root,
    env: {...process.env, PORT: String(port), CONTROL_BASE_URL: 'http://bi-control:18089'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
  await waitForServer(port, child);

  const manifest = JSON.parse(await readFile(path.join(assetRoot, 'brand-assets.json'), 'utf8'));
  const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  for (const reference of [
    '<link rel="icon" href="/assets/kaleidosphere-logo.svg" type="image/svg+xml">',
    '<link rel="icon" href="/assets/favicon-32x32.png" sizes="32x32" type="image/png">',
    '<link rel="icon" href="/assets/favicon-16x16.png" sizes="16x16" type="image/png">',
    '<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" sizes="180x180">',
    '<link rel="manifest" href="/assets/site.webmanifest">',
    '<img class="brand-logo" src="/assets/kaleidosphere-logo.svg" width="112" height="112" alt="">',
  ]) assert(page.includes(reference), reference);

  for (const asset of manifest.assets) {
    const response = await fetch(`http://127.0.0.1:${port}${asset.route}`);
    assert.equal(response.status, 200, asset.route);
    assert.equal(response.headers.get('content-type'), asset.mimeType === 'image/svg+xml' ? 'image/svg+xml; charset=utf-8' : asset.mimeType);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), asset.sha256, asset.route);
  }

  const capabilityManifestResponse = await fetch(`http://127.0.0.1:${port}/v2/capability-manifest`);
  assert.equal(capabilityManifestResponse.status, 200);
  assert.equal(capabilityManifestResponse.headers.get('cache-control'), 'no-store');
  const capabilityManifest = await capabilityManifestResponse.json();
  assert.equal(capabilityManifest.schemaVersion, 'kaleidosphere.external/capability-manifest/v1');
  assert.deepEqual(capabilityManifest.capabilities.map(({action}) => action), ['status', 'discovery', 'analyze', 'plan', 'preview', 'readback']);

  const webManifestResponse = await fetch(`http://127.0.0.1:${port}/assets/site.webmanifest`);
  assert.equal(webManifestResponse.status, 200);
  assert.equal(webManifestResponse.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
  assert.deepEqual((await webManifestResponse.json()).icons.map(({src}) => src), ['/assets/icon-192.png', '/assets/icon-512.png']);

  for (const [requestPath, method] of [
    ['/assets/unknown.png', 'GET'],
    ['/assets/%2e%2e/package.json', 'GET'],
    ['/assets/favicon-32x32.png', 'POST'],
  ]) {
    const response = await rawRequest(port, requestPath, method);
    assert.equal(response.status, 400, `${method} ${requestPath}`);
    assert.equal(JSON.parse(response.body).code, 'AGENT_ROUTE_DENIED');
  }
});
