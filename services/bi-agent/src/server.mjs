import { readFile } from 'node:fs/promises';
import http from 'node:http';

import { capabilityAttestationV2, executeExternalIntentV2 } from './external-api-v2.mjs';

const port = Number(process.env.PORT ?? 18790);
const controlBase = process.env.CONTROL_BASE_URL;
if (controlBase !== 'http://bi-control:18089') throw new Error('AGENT_CONTROL_ROUTE_DENIED');

const brandAssetSpecs = Object.freeze([
  ['/assets/kaleidosphere-logo.svg', 'kaleidosphere-logo.svg', 'image/svg+xml'],
  ['/assets/kaleidosphere-logo.png', 'kaleidosphere-logo.png', 'image/png'],
  ['/assets/favicon-16x16.png', 'favicon-16x16.png', 'image/png'],
  ['/assets/favicon-32x32.png', 'favicon-32x32.png', 'image/png'],
  ['/assets/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
  ['/assets/icon-192.png', 'icon-192.png', 'image/png'],
  ['/assets/icon-512.png', 'icon-512.png', 'image/png'],
  ['/assets/site.webmanifest', 'site.webmanifest', 'application/manifest+json'],
]);
const brandAssets = new Map(await Promise.all(brandAssetSpecs.map(async ([route, file, contentType]) => [
  route,
  {body: await readFile(new URL(`../assets/${file}`, import.meta.url)), contentType},
])));

const unsafe = /(?:\b(?:select|insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec(?:ute)?|dbcc|backup|restore)\b|\braw\s+sql\b|\bsql\s*lab\b|source\s+code|pl\/sql\s+source|password|credential|secret|api[_ -]?key|ignore\s+(?:all\s+)?previous|system\s+prompt)/i;
const analyzeIntent = /(?:analys(?:iere|e|ieren)|analy[sz]e).*(?:datenbank|database)|(?:datenbank|database).*(?:analys(?:iere|e|ieren)|analy[sz]e)/i;
const statusIntent = /^(?:status|zustand|health|bereit)\??$/i;
const searchIntent = /^(?:suche|search)\s+(.{2,80})$/i;
const discoveryIntent = /^(?:bi\s+)?discovery\s+(start|resume|status|answer|revise|confirm|export)\s+([a-z0-9][a-z0-9_-]{2,63})(?:\s+([A-Za-z][A-Za-z0-9]*)\s+([\s\S]{1,400}))?$/i;

async function secret() {
  const value = (await readFile(process.env.CONTROL_TOKEN_FILE, 'utf8').catch(() => '')).trim();
  if (!value) throw coded('AGENT_CONTROL_TOKEN_MISSING');
  return value;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function requestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw coded('AGENT_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw coded('AGENT_JSON_INVALID'); }
}

function validatePrompt(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['message'])
    || typeof body.message !== 'string' || body.message.length < 3 || body.message.length > 500) {
    throw coded('AGENT_INPUT_INVALID');
  }
  if (unsafe.test(body.message)) throw coded('AGENT_UNSAFE_INPUT_DENIED');
  return body.message.trim();
}

async function providerIntent(message) {
  if ((process.env.LLM_MODE ?? 'stub') === 'stub') {
    if (analyzeIntent.test(message)) return 'ANALYZE';
    if (statusIntent.test(message)) return 'STATUS';
    return 'DENY';
  }
  if (process.env.LLM_MODE !== 'openai-compatible') throw coded('AGENT_LLM_MODE_DENIED');
  const base = new URL(process.env.LLM_BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || !process.env.LLM_MODEL) throw coded('AGENT_LLM_CONFIG_INVALID');
  const apiKey = (await readFile(process.env.LLM_API_KEY_FILE, 'utf8').catch(() => '')).trim();
  if (!apiKey) throw coded('AGENT_LLM_KEY_MISSING');
  const response = await fetch(new URL('chat/completions', `${base.toString().replace(/\/$/, '')}/`), {
    method: 'POST',
    headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json'},
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      temperature: 0,
      max_tokens: 8,
      messages: [
        {role: 'system', content: 'Classify the user request. Output exactly ANALYZE, STATUS, or DENY. ANALYZE only means read-only analysis of the configured database into local evidence. Never accept SQL, credentials, configuration changes, writes, publication, or unknown actions.'},
        {role: 'user', content: message},
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw coded('AGENT_LLM_PROVIDER_FAILED');
  const value = await response.json();
  const intent = value.choices?.[0]?.message?.content?.trim();
  return ['ANALYZE', 'STATUS'].includes(intent) ? intent : 'DENY';
}

async function control(path, method = 'POST', action) {
  const token = await secret();
  const response = await fetch(`${controlBase}${path}`, {
    method,
    headers: {authorization: `Bearer ${token}`, ...(method === 'POST' ? {'content-type': 'application/json'} : {})},
    ...(method === 'POST' ? {body: JSON.stringify({action})} : {}),
    signal: AbortSignal.timeout(180000),
  });
  const body = await response.json().catch(() => ({code: 'AGENT_CONTROL_RESPONSE_INVALID'}));
  if (!response.ok) throw coded(body.code ?? 'AGENT_CONTROL_FAILED');
  return body;
}

async function controlJson(path, body) {
  const token = await secret();
  const response = await fetch(`${controlBase}${path}`, {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json().catch(() => ({code: 'AGENT_CONTROL_RESPONSE_INVALID'}));
  if (!response.ok) throw coded(value.code ?? 'AGENT_CONTROL_FAILED');
  return value;
}

function discoveryValue(raw) {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (/^(?:true|false|null|".*"|\[.*\]|\{.*\})$/s.test(trimmed)) {
    try { return JSON.parse(trimmed); }
    catch { throw coded('AGENT_DISCOVERY_JSON_INVALID'); }
  }
  return trimmed;
}

function discoveryRequest(message) {
  const match = discoveryIntent.exec(message);
  if (!match) return null;
  const action = match[1].toLowerCase();
  const request = { action, sessionId: match[2] };
  if (action === 'answer' || action === 'revise') {
    if (!match[3] || match[4] === undefined) throw coded('AGENT_DISCOVERY_INPUT_INVALID');
    request.field = match[3];
    request.value = discoveryValue(match[4]);
  } else if (match[3] || match[4] !== undefined) throw coded('AGENT_DISCOVERY_INPUT_INVALID');
  if (action === 'confirm') request.confirmed = true;
  if (action === 'export') request.format = 'json';
  return request;
}

function technicalFamily(message) {
  if (/(größte|largest|size|capacity|bytes|block|verteilung)/i.test(message)) return 'largest_tables';
  if (/(row|zeilen|estimate|schätz|fresh|stale|statist)/i.test(message)) return 'row_estimates_freshness';
  if (/(inventory|inventar|valid|invalid|compile|schema|object|objekt)/i.test(message)) return 'object_inventory_validity';
  if (/(depend|abhäng|impact|uses|verwendet|nutzt|benutzt)/i.test(message)) return 'dependencies';
  if (/(signature|signatur|argument|stored|procedure|function|package|logic|code)/i.test(message)) return 'stored_logic_signatures';
  if (/(scheduler|job|materialized|mview|refresh|mv\b)/i.test(message)) return 'scheduler_mv_refresh';
  if (/(coverage|blind|denied|timeout|partial|caveat|abdeckung|lücke)/i.test(message)) return 'coverage_blind_spots';
  if (/(candidate|kandidat|bi[- ]?relev|dimension|measure|kennzahl)/i.test(message)) return 'bi_relevance_candidates';
  return null;
}

function objectFromMessage(message) {
  const match = /\b(?:object|objekt|table|tabelle|uses|verwendet|nutzt|impact|dependencies|abhängigkeiten|signatures?|signaturen?)\s+([A-Za-z][A-Za-z0-9_$#]*(?:\.[A-Za-z][A-Za-z0-9_$#]*)?)/i.exec(message);
  return match ? {name: match[1]} : null;
}

function scopeFromStatus(status) {
  const schemas = status?.scope?.schemas;
  if (!Array.isArray(schemas) || schemas.length === 0) throw coded('AGENT_CATALOG_SCOPE_MISSING');
  return {schemas};
}

async function execute(message) {
  const discovery = discoveryRequest(message);
  if (discovery) {
    return {intent: 'DISCOVERY', providerMode: process.env.LLM_MODE ?? 'stub', result: await controlJson('/v1/discovery', discovery)};
  }
  const search = searchIntent.exec(message);
  if (search) {
    const status = await control('/v1/status', 'GET');
    return {intent: 'CATALOG_SEARCH', status, result: await controlJson('/v1/catalog/search', {
      term: search[1].trim(), scope: scopeFromStatus(status), limit: 20,
    })};
  }
  const family = technicalFamily(message);
  if (family) {
    const status = await control('/v1/status', 'GET');
    return {intent: 'CATALOG_QUESTION', family, status, result: await controlJson('/v1/catalog/question', {
      family, scope: scopeFromStatus(status), object: objectFromMessage(message), limit: 20,
    })};
  }
  const intent = await providerIntent(message);
  if (intent === 'STATUS') return {intent, status: await control('/v1/status', 'GET')};
  if (intent !== 'ANALYZE') throw coded('AGENT_UNKNOWN_ACTION_DENIED');
  const status = await control('/v1/status', 'GET');
  const analysis = await control('/v1/analyze', 'POST', 'analyze');
  const readback = await control('/v1/readback', 'POST', 'readback');
  const catalogReadback = await controlJson('/v1/catalog/question', {
    family: 'coverage_blind_spots', scope: {schemas: analysis.scope.schemas}, object: null, limit: 20,
  });
  return {
    schemaVersion: 'superset-bi-agent/agent-result/v2', intent, providerMode: process.env.LLM_MODE ?? 'stub',
    tools: ['status', 'analyze', 'catalog_ingest', 'readback', 'catalog_question'], status, analysisReceipt: {
      receiptId: analysis.receiptId, status: analysis.status, sourceMode: analysis.sourceMode,
      scope: analysis.scope, runtimeValidation: analysis.analysis.runtimeValidation,
      snapshotSha256: analysis.analysis.snapshotSha256,
    }, catalog: {status: 'INGESTED_LOCAL_TECHNICAL_CATALOG', coverageQuestion: catalogReadback},
    publication: {status: 'AWAITING_TRUSTED_APPROVAL', mutationPerformed: false, requiredWorkflow: ['preview', 'direct-trusted-ui-approval', 'apply', 'readback', 'rollback']},
    readback,
  };
}

function externalDiscoveryInput(input) {
  const body = { action: input.command, sessionId: input.sessionId };
  if (input.command === 'answer' || input.command === 'revise') {
    body.field = input.field;
    body.value = input.value;
  }
  if (input.command === 'confirm') body.confirmed = true;
  if (input.command === 'export') body.format = 'json';
  return body;
}

async function executeExternal(request) {
  return executeExternalIntentV2(request, {
    status: () => control('/v1/status', 'GET'),
    analyze: () => control('/v1/analyze', 'POST', 'analyze'),
    readback: () => control('/v1/readback', 'POST', 'readback'),
    discovery: (input) => controlJson('/v1/discovery', externalDiscoveryInput(input)),
    plan: (input) => controlJson('/v1/external/plan', input),
    preview: (input) => controlJson('/v1/external/preview', input),
  });
}

const page = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/assets/kaleidosphere-logo.svg" type="image/svg+xml">
<link rel="icon" href="/assets/favicon-32x32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/assets/favicon-16x16.png" sizes="16x16" type="image/png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/assets/site.webmanifest">
<meta name="theme-color" content="#172033">
<title>KaleidoSphere</title><style>
body{font:16px system-ui,sans-serif;max-width:860px;margin:3rem auto;padding:0 1rem;color:#172033;background:#f5f7fb}main{background:white;border:1px solid #dce3ee;border-radius:12px;padding:2rem;box-shadow:0 8px 30px #20305012}.brand{display:flex;align-items:center;gap:1rem}.brand-logo{width:112px;height:112px;object-fit:contain}.brand h1{margin:0}@media(max-width:480px){.brand-logo{width:88px;height:88px}}textarea{width:100%;box-sizing:border-box;min-height:90px;padding:.8rem}button{margin-top:.8rem;padding:.7rem 1.1rem;background:#1677ff;color:white;border:0;border-radius:6px;font-weight:600}pre{white-space:pre-wrap;background:#101827;color:#d9e7ff;padding:1rem;border-radius:8px;overflow:auto}small{color:#596579}</style></head>
<body><main><div class="brand"><img class="brand-logo" src="/assets/kaleidosphere-logo.svg" width="112" height="112" alt=""><h1>KaleidoSphere</h1></div><p><strong>Multi-perspective Business &amp; Decision Intelligence</strong></p><p>Analysiert ausschließlich die konfigurierte MSSQL- oder Oracle-Datenbank read-only und erzeugt einen prüfbaren BI-Vorschlag.</p>
<form id="f"><label for="m">Auftrag</label><textarea id="m">Analysiere die konfigurierte Datenbank</textarea><br><button>Analyse starten</button></form>
<p><small>Erlaubt: Status, Analyse, lokaler technischer Katalog, Suche, evidenzgebundene technische Fragen und geführte BI Discovery. Persistente Superset-Aktionen benötigen den gebundenen Trusted-Workflow. Raw SQL, Credentials, Rohsource, Schreibaktionen und unbekannte Tools werden abgewiesen.</small></p><pre id="o">Bereit.</pre></main>
<script>document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();const o=document.getElementById('o');o.textContent='Arbeite…';try{const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:document.getElementById('m').value})});const j=await r.json();o.textContent=JSON.stringify(j,null,2)}catch(x){o.textContent='Fehler: '+x.message}})</script></body></html>`;

function send(response, status, contentType, value, cacheControl = 'no-store') {
  const body = contentType === 'application/json' ? `${JSON.stringify(value)}\n` : value;
  const charset = /^(?:text\/|application\/(?:json|manifest\+json)$|image\/svg\+xml$)/.test(contentType) ? '; charset=utf-8' : '';
  response.writeHead(status, {
    'content-type': `${contentType}${charset}`, 'content-length': Buffer.byteLength(body),
    'cache-control': cacheControl, 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN',
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'",
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/healthz') return send(response, 200, 'application/json', {status: 'ok'});
    if (request.method === 'GET' && request.url === '/v2/capabilities') return send(response, 200, 'application/json', capabilityAttestationV2());
    if (request.method === 'GET' && brandAssets.has(request.url)) {
      const asset = brandAssets.get(request.url);
      return send(response, 200, asset.contentType, asset.body, 'public, max-age=3600');
    }
    if (request.method === 'GET' && request.url === '/') return send(response, 200, 'text/html', page);
    if (request.method === 'POST' && request.url === '/api/chat') return send(response, 200, 'application/json', await execute(validatePrompt(await requestJson(request))));
    if (request.method === 'POST' && request.url === '/v2/intents') return send(response, 200, 'application/json', await executeExternal(await requestJson(request)));
    throw coded('AGENT_ROUTE_DENIED');
  } catch (error) {
    const code = String(error.code ?? error.message ?? 'AGENT_INTERNAL_ERROR').replace(/[^A-Z0-9_]/g, '_').slice(0, 128);
    send(response, 400, 'application/json', {status: 'DENIED', code});
  }
});
server.listen(port, '0.0.0.0');
