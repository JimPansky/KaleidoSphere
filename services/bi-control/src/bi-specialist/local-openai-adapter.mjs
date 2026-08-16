import { createHash } from 'node:crypto';

const fail = (code, details = undefined) => {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
};

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const SECRET = /(bearer\s+[a-z0-9._~+\/-]+|sk-[a-z0-9_-]{12,}|hf_[a-z0-9]{12,}|-----begin [a-z ]+private key-----)/i;
const SENSITIVE_KEY = /(password|secret|token|authorization|cookie|chain.?of.?thought|reasoning|raw.?row|source.?row)/i;

function safeTraceValue(value, path = '$') {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return SECRET.test(value) ? '[REDACTED]' : value.slice(0, 512);
  if (Array.isArray(value)) return value.slice(0, 32).map((item, index) => safeTraceValue(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return '[UNSUPPORTED]';
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE_KEY.test(key)).slice(0, 48)
    .map(([key, item]) => [key, safeTraceValue(item, `${path}.${key}`)]));
}

function validatePrimitive(value, schema, path) {
  if (!schema || typeof schema !== 'object') fail('TOOL_SCHEMA_INVALID', path);
  if (schema.enum && !schema.enum.includes(value)) fail('TOOL_ARGUMENT_ENUM_INVALID', path);
  if (schema.type === 'string' && typeof value !== 'string') fail('TOOL_ARGUMENT_TYPE_INVALID', path);
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) fail('TOOL_ARGUMENT_TYPE_INVALID', path);
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) fail('TOOL_ARGUMENT_TYPE_INVALID', path);
  if (schema.type === 'boolean' && typeof value !== 'boolean') fail('TOOL_ARGUMENT_TYPE_INVALID', path);
  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('TOOL_ARGUMENT_TYPE_INVALID', path);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('TOOL_ARGUMENT_BUDGET_EXCEEDED', path);
    value.forEach((item, index) => validatePrimitive(item, schema.items ?? {}, `${path}[${index}]`));
  }
  if (schema.type === 'object') {
    if (!value || Array.isArray(value) || typeof value !== 'object') fail('TOOL_ARGUMENT_TYPE_INVALID', path);
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) if (!(required in value)) fail('TOOL_ARGUMENT_REQUIRED_MISSING', `${path}.${required}`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) fail('TOOL_ARGUMENT_UNKNOWN', `${path}.${key}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validatePrimitive(item, properties[key], `${path}.${key}`);
    }
  }
}

export class ReconciliationLedger {
  #entries = new Map();

  begin(key, requestDigest) {
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.requestDigest !== requestDigest) fail('IDEMPOTENCY_KEY_CONFLICT');
      return structuredClone(existing);
    }
    const entry = { key, requestDigest, state: 'started', attempts: 0, response: null };
    this.#entries.set(key, entry);
    return structuredClone(entry);
  }

  attempt(key) {
    const entry = this.#entries.get(key);
    if (!entry) fail('RECONCILIATION_ENTRY_UNKNOWN');
    entry.attempts += 1;
  }

  complete(key, response) {
    const entry = this.#entries.get(key);
    if (!entry) fail('RECONCILIATION_ENTRY_UNKNOWN');
    entry.state = 'complete';
    entry.response = structuredClone(response);
    return structuredClone(entry);
  }

  fail(key, code) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.state = 'failed';
    entry.errorCode = code;
  }

  snapshot() { return [...this.#entries.values()].map((entry) => structuredClone(entry)); }

  static restore(entries) {
    const ledger = new ReconciliationLedger();
    for (const entry of entries) ledger.#entries.set(entry.key, structuredClone(entry));
    return ledger;
  }
}

export class LocalOpenAIAdapter {
  constructor({ baseUrl, model, fetchImpl = fetch, timeoutMs = 20_000, maxRetries = 1,
    maxInputChars = 32_000, maxOutputTokens = 1_024, ledger = new ReconciliationLedger() }) {
    if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/v1$/.test(baseUrl)) fail('LOCAL_ENDPOINT_REQUIRED');
    if (!model || typeof model !== 'string') fail('MODEL_ID_REQUIRED');
    this.baseUrl = baseUrl;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.maxInputChars = maxInputChars;
    this.maxOutputTokens = maxOutputTokens;
    this.ledger = ledger;
    this.traces = [];
  }

  buildRequest({ messages, temperature = 0.1, topP = 0.95, seed = 7, maxTokens = this.maxOutputTokens,
    responseFormat, tools, toolChoice, stream = false }) {
    if (!Array.isArray(messages) || messages.length === 0) fail('MESSAGES_REQUIRED');
    const inputChars = JSON.stringify(messages).length;
    if (inputChars > this.maxInputChars) fail('CONTEXT_BUDGET_EXCEEDED', { inputChars, max: this.maxInputChars });
    if (!(temperature >= 0 && temperature <= 1)) fail('TEMPERATURE_INVALID');
    if (!(topP > 0 && topP <= 1)) fail('TOP_P_INVALID');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > this.maxOutputTokens) fail('RESPONSE_BUDGET_EXCEEDED');
    const body = { model: this.model, messages, temperature, top_p: topP, seed, max_tokens: maxTokens, stream };
    if (responseFormat) body.response_format = responseFormat;
    if (tools) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    return body;
  }

  async complete(options) {
    const body = this.buildRequest({ ...options, stream: false });
    const key = options.idempotencyKey ?? `auto:${digest(body)}`;
    const requestDigest = digest(body);
    const known = this.ledger.begin(key, requestDigest);
    if (known.state === 'complete') return structuredClone(known.response);
    const startedAt = Date.now();
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      this.ledger.attempt(key);
      const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': key }, body: JSON.stringify(body), signal,
        });
        if (!response.ok) {
          if (TRANSIENT.has(response.status) && attempt < this.maxRetries) continue;
          fail('MODEL_HTTP_FAILED', { status: response.status });
        }
        const payload = await response.json();
        const result = this.#parseResponse(payload, options.tools ?? []);
        result.receipt = { idempotencyKey: key, requestDigest, attempts: attempt + 1 };
        this.ledger.complete(key, result);
        this.traces.push({ type: 'model_call', model: this.model, requestDigest, sampling: {
          temperature: body.temperature, topP: body.top_p, seed: body.seed, maxTokens: body.max_tokens,
        }, inputChars: JSON.stringify(body.messages).length, outputChars: result.content.length,
        toolCallCount: result.toolCalls.length, latencyMs: Date.now() - startedAt, status: 'complete' });
        return result;
      } catch (error) {
        lastError = error;
        if ((error.name === 'TimeoutError' || error.name === 'AbortError') && attempt < this.maxRetries && !options.signal?.aborted) continue;
        this.ledger.fail(key, error.code ?? (options.signal?.aborted ? 'MODEL_CANCELLED' : 'MODEL_TIMEOUT'));
        if (options.signal?.aborted) fail('MODEL_CANCELLED');
        if (error.name === 'TimeoutError' || error.name === 'AbortError') fail('MODEL_TIMEOUT');
        throw error;
      }
    }
    throw lastError;
  }

  async *stream(options) {
    const body = this.buildRequest({ ...options, stream: true });
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
      });
      if (!response.ok || !response.body) fail('MODEL_STREAM_HTTP_FAILED', { status: response.status });
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') yield delta;
        }
      }
    } catch (error) {
      if (options.signal?.aborted) fail('MODEL_CANCELLED');
      if (error.name === 'TimeoutError' || error.name === 'AbortError') fail('MODEL_TIMEOUT');
      throw error;
    }
  }

  #parseResponse(payload, tools) {
    const message = payload?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') fail('MODEL_RESPONSE_INVALID');
    const content = typeof message.content === 'string' ? message.content : '';
    if (content.length > this.maxOutputTokens * 8) fail('MODEL_RESPONSE_BUDGET_EXCEEDED');
    const catalog = new Map(tools.map((tool) => [tool?.function?.name, tool?.function?.parameters]));
    const toolCalls = (message.tool_calls ?? []).map((call) => {
      const name = call?.function?.name;
      if (!catalog.has(name)) fail('TOOL_UNKNOWN', name);
      let args;
      try { args = JSON.parse(call.function.arguments); } catch { fail('TOOL_ARGUMENT_JSON_INVALID', name); }
      validatePrimitive(args, catalog.get(name), `tool.${name}`);
      return { id: call.id, name, arguments: args };
    });
    return { content, toolCalls, usage: safeTraceValue(payload.usage ?? {}) };
  }
}

export async function executeReadOnlyToolCall(call, toolRegistry) {
  const tool = toolRegistry[call.name];
  if (!tool || tool.readOnly !== true || typeof tool.execute !== 'function') fail('TOOL_EXECUTION_BOUNDARY_DENIED');
  const result = await tool.execute(structuredClone(call.arguments));
  return safeTraceValue(result);
}

export function privacySafeTrace(trace) { return safeTraceValue(trace); }
