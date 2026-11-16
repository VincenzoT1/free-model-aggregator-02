// Free-Model Aggregator with Dynamic Optimal Quality Routing & Resilient Failover v2.1
// Engineered for make.fun free-model-aggregator-02 competition - highest quality model selection
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

// Configuration and Constants
const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';
const FIXED_OPENAI_CREATED = 1767225600;
const FIXED_ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

// Types
export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface ModelRow {
  id: string;
  provider: string;
  display_name: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

export interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

export interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error: string | null;
}

export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

export interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: 'openai';
  models: CatalogModel[];
}

export interface CatalogReport {
  providers: CatalogProvider[];
}

export interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

// Brief & Catalog Parsing
function documentsIn(text: string): Json[] {
  const docs: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') docs.push(value);
    } catch {
      // Continue parsing next json block
    }
  }
  return docs;
}

function parseModelRow(v: unknown): ModelRow | null {
  if (!isRecord(v)) return null;
  const rawId = typeof v.id === 'string' && v.id !== '' ? v.id : typeof v.model === 'string' ? v.model : '';
  if (rawId === '') return null;
  const rawProvider = typeof v.provider === 'string' && v.provider !== '' ? v.provider : typeof v.wire === 'string' ? v.wire : 'openrouter';
  const id = rawProvider === 'openrouter' && !rawId.toLowerCase().startsWith('openrouter/') ? `openrouter/${rawId}` : rawId;
  return {
    id,
    provider: rawProvider,
    display_name: typeof v.display_name === 'string' && v.display_name !== '' ? v.display_name : rawId,
    rating_milli: typeof v.rating_milli === 'number' && Number.isFinite(v.rating_milli) ? v.rating_milli : 0,
    context_length: typeof v.context_length === 'number' && Number.isFinite(v.context_length) ? v.context_length : null,
    tools: typeof v.tools === 'boolean' ? v.tools : null,
    vision: typeof v.vision === 'boolean' ? v.vision : null,
    json: typeof v.json === 'boolean' ? v.json : null,
    free: v.free !== false,
  };
}

function parsePromptRow(v: unknown): PromptRow | null {
  if (!isRecord(v)) return null;
  const id = typeof v.id === 'string' ? v.id : '';
  if (id === '') return null;
  const req = isRecord(v.requires) ? v.requires : {};
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires: {
      ...(req.tools === true ? { tools: true } : {}),
      ...(req.vision === true ? { vision: true } : {}),
      ...(req.json === true ? { json: true } : {}),
      ...(typeof req.min_context === 'number' && Number.isFinite(req.min_context) ? { min_context: req.min_context } : {}),
    },
  };
}

export function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(content);
  let modelsDoc: Json | null = null;
  let modelsKey = 'models';
  let promptsDoc: Json | null = null;
  let promptsKey = 'prompts';

  for (const doc of docs) {
    const schema = typeof doc.schema === 'string' ? doc.schema : '';
    if (!schema.includes('free-model-aggregator-02/')) continue;
    if (modelsDoc === null) {
      if (Array.isArray(doc.models)) {
        modelsDoc = doc;
        modelsKey = 'models';
      } else if (Array.isArray(doc.ratings)) {
        modelsDoc = doc;
        modelsKey = 'ratings';
      }
    }
    if (promptsDoc === null) {
      if (Array.isArray(doc.prompts)) {
        promptsDoc = doc;
        promptsKey = 'prompts';
      } else if (Array.isArray(doc.manifest)) {
        promptsDoc = doc;
        promptsKey = 'manifest';
      }
    }
  }

  const models = modelsDoc !== null ? (modelsDoc[modelsKey] as unknown[]).flatMap((v) => {
    const row = parseModelRow(v);
    return row !== null ? [row] : [];
  }) : [];

  const prompts = promptsDoc !== null ? (promptsDoc[promptsKey] as unknown[]).flatMap((v) => {
    const row = parsePromptRow(v);
    return row !== null ? [row] : [];
  }) : [];

  return { models, prompts, error: null };
}

export function buildCatalog(brief: Brief): CatalogReport {
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const model of brief.models) {
    if (!model.free || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, free: true, context_length: model.context_length });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: OPENROUTER_KEY_ENV,
        wire: 'openai',
        models,
      },
    ],
  };
}

// Runtime State
const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
let manifestIndex = 0;
const cooldownModels = new Set<string>();

function log(msg: string): void {
  process.stderr.write(`[aggregator] ${msg}\n`);
}

function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

function freeModelsList(): ModelRow[] {
  return brief.models.filter((m) => m.free);
}

function meetsRequirements(requires: Requirement, model: ModelRow): boolean {
  if (requires.tools === true && model.tools !== true) return false;
  if (requires.vision === true && model.vision !== true) return false;
  if (requires.json === true && model.json !== true) return false;
  if (requires.min_context !== undefined && (model.context_length === null || model.context_length < requires.min_context)) return false;
  return true;
}

function selectCandidates(requires: Requirement): ModelRow[] {
  const matching = freeModelsList().filter((m) => meetsRequirements(requires, m));
  // Sort descending by quality rating, tie-break by ID
  matching.sort((a, b) => b.rating_milli - a.rating_milli || a.id.localeCompare(b.id));

  const available = matching.filter((m) => !cooldownModels.has(m.id));
  if (available.length > 0) return available;
  return matching;
}

function determineRequirements(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;

  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: format === 'json_object' || format === 'json_schema',
  };
}

// Wire Helper Utilities
export function openAIError(message: string, type: string, code: string | null): Json {
  return { error: { message, type, code } };
}

export function anthropicError(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

export function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}

function stopReasonOf(finish: unknown): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseArguments(val: unknown): Json {
  if (isRecord(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(val);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Empty input
    }
  }
  return {};
}

// Anthropic <-> OpenAI Conversion
export function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOfContent(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of rawMessages) {
    if (!isRecord(raw)) continue;
    const isAssistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: isAssistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (isAssistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOfContent(content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        messages.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: resultText,
        });
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && isRecord(block.source)) {
        const src = block.source;
        if (src.type === 'base64' && typeof src.data === 'string') {
          const media = typeof src.media_type === 'string' ? src.media_type : 'image/png';
          parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${src.data}` } });
        } else if (src.type === 'url' && typeof src.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: src.url } });
        }
      }
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }

  const payload: Json = { model, messages };
  if (typeof body.max_tokens === 'number') payload.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  if (typeof body.top_p === 'number') payload.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) payload.stop = body.stop_sequences;

  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) payload.tools = tools;
  }

  if (isRecord(body.tool_choice)) {
    const choice = body.tool_choice;
    if (choice.type === 'auto') payload.tool_choice = 'auto';
    else if (choice.type === 'any') payload.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') payload.tool_choice = { type: 'function', function: { name: choice.name } };
  }

  if (body.stream === true) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  }
  return payload;
}

export function openAIToAnthropic(body: Json, model: string): Json {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const text = typeof message.content === 'string' ? message.content : textOfContent(message.content);
  if (text !== '') content.push({ type: 'text', text });

  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' ? call.id : 'toolu_default',
      name: typeof call.function.name === 'string' ? call.function.name : '',
      input: parseArguments(call.function.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    id: `msg_${typeof body.id === 'string' ? body.id : 'res'}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReasonOf(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: numberOrZero(usage.prompt_tokens),
      output_tokens: numberOrZero(usage.completion_tokens),
    },
  };
}

// SSE Transformers
function rewriteFrameModel(frame: string, model: string): string {
  const lines = frame.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return line;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return line;
    try {
      const chunk: unknown = JSON.parse(payload);
      if (isRecord(chunk)) return `data: ${JSON.stringify({ ...chunk, model })}`;
    } catch {
      // Keep line
    }
    return line;
  });
  return `${lines.join('\n')}\n\n`;
}

export async function* openAIStreamRelay(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        yield rewriteFrameModel(frame, model);
        idx = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') yield rewriteFrameModel(buffer, model);
  } finally {
    reader.releaseLock();
  }
}

export async function* anthropicEventsRelay(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;
  let finished = false;
  let pendingStop: string | null = null;
  let textIndex = -1;
  let nextIndex = 0;
  const toolIndexes = new Map<number, number>();
  let inputTokens = 0;
  let outputTokens = 0;

  const emitStart = (): string[] => {
    if (started) return [];
    started = true;
    return [
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      }),
    ];
  };

  const emitCloseBlocks = (): string[] => {
    const out: string[] = [];
    if (textIndex !== -1) {
      out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
      textIndex = -1;
    }
    for (const idx of [...toolIndexes.values()].sort((a, b) => a - b)) {
      out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: idx }));
    }
    toolIndexes.clear();
    return out;
  };

  const emitFinish = (stopReason: string): string[] => {
    if (finished) return [];
    finished = true;
    return [
      ...emitCloseBlocks(),
      sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
      sseEvent('message_stop', { type: 'message_stop' }),
    ];
  };

  const processFrame = (frame: string): string[] => {
    const events: string[] = [];
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        events.push(...emitStart(), ...emitFinish(pendingStop ?? 'end_turn'));
        continue;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;
      if (isRecord(chunk.usage)) {
        inputTokens = numberOrZero(chunk.usage.prompt_tokens);
        outputTokens = numberOrZero(chunk.usage.completion_tokens);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : null;
      if (choice === null) continue;

      events.push(...emitStart());
      const delta = isRecord(choice.delta) ? choice.delta : {};

      if (typeof delta.content === 'string' && delta.content !== '') {
        if (textIndex === -1) {
          textIndex = nextIndex;
          nextIndex += 1;
          events.push(sseEvent('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }));
        }
        events.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } }));
      }

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of toolCalls) {
        if (!isRecord(call)) continue;
        const upstreamIdx = typeof call.index === 'number' ? call.index : toolIndexes.size;
        let mappedIdx = toolIndexes.get(upstreamIdx);
        if (mappedIdx === undefined) {
          if (textIndex !== -1) {
            events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
            textIndex = -1;
          }
          mappedIdx = nextIndex;
          nextIndex += 1;
          toolIndexes.set(upstreamIdx, mappedIdx);
          const fn = isRecord(call.function) ? call.function : {};
          events.push(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index: mappedIdx,
              content_block: {
                type: 'tool_use',
                id: typeof call.id === 'string' && call.id !== '' ? call.id : `toolu_${mappedIdx}`,
                name: typeof fn.name === 'string' ? fn.name : '',
                input: {},
              },
            }),
          );
        }
        const fn = isRecord(call.function) ? call.function : {};
        if (typeof fn.arguments === 'string' && fn.arguments !== '') {
          events.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: mappedIdx, delta: { type: 'input_json_delta', partial_json: fn.arguments } }));
        }
      }

      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        pendingStop = stopReasonOf(choice.finish_reason);
      }
    }
    return events;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const ev of processFrame(frame)) yield ev;
        idx = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') {
      for (const ev of processFrame(buffer)) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
  if (!finished) {
    for (const ev of emitStart()) yield ev;
    for (const ev of emitFinish(pendingStop ?? 'end_turn')) yield ev;
  }
}

// Request Execution & Forwarding
async function readJsonBody(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    const val: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(val) ? val : null;
  } catch {
    return null;
  }
}

function respondJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

async function dialGateway(modelId: string, payload: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (payload.stream === true) headers.accept = 'text/event-stream';
  const body: Json = { ...payload, model: modelId };
  if (body.max_tokens === undefined && body.max_completion_tokens === undefined) {
    body.max_tokens = 1024;
  }
  return fetch(chatCompletionsUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// HTTP Route Handlers
function handleModelsRoute(req: IncomingMessage, res: ServerResponse): void {
  const freeModels = freeModelsList();
  if (typeof req.headers['x-api-key'] === 'string') {
    respondJson(res, 200, {
      data: freeModels.map((m) => ({
        type: 'model',
        id: m.id,
        display_name: m.display_name,
        created_at: FIXED_ANTHROPIC_CREATED_AT,
      })),
      has_more: false,
    });
  } else {
    respondJson(res, 200, {
      object: 'list',
      data: freeModels.map((m) => ({
        id: m.id,
        object: 'model',
        created: FIXED_OPENAI_CREATED,
        owned_by: m.provider,
      })),
    });
  }
}

async function handleChatRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null) {
    return respondJson(res, 400, openAIError('the request body is not one JSON object', 'invalid_request_error', null));
  }

  const requirements = determineRequirements(body);
  const candidates = selectCandidates(requirements);
  if (candidates.length === 0) {
    return respondJson(res, 503, openAIError('no free model in the brief meets this request', 'no_free_model', null));
  }

  const failures: UpstreamFailure[] = [];

  for (const candidate of candidates) {
    let upstreamRes: Response;
    try {
      upstreamRes = await dialGateway(candidate.id, { ...body, model: candidate.id });
    } catch {
      cooldownModels.add(candidate.id);
      failures.push({ status: 502, code: 'upstream_error', model: candidate.id });
      continue;
    }

    if (!upstreamRes.ok || upstreamRes.body === null) {
      await upstreamRes.text().catch(() => '');
      cooldownModels.add(candidate.id);
      failures.push({ status: upstreamRes.status, code: 'refusal', model: candidate.id });
      log(`failover: ${candidate.id} failed HTTP ${upstreamRes.status}, switching candidate...`);
      continue;
    }

    const extraHeaders: Record<string, string> = {};
    if (failures.length > 0) {
      extraHeaders['x-makefun-upstream-failures'] = JSON.stringify(failures.slice(0, 8));
    }

    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...extraHeaders,
      });
      try {
        for await (const frame of openAIStreamRelay(upstreamRes.body, candidate.id)) {
          res.write(frame);
        }
      } finally {
        res.end();
      }
      return;
    }

    const answer: unknown = await upstreamRes.json().catch(() => ({}));
    const finalAnswer = isRecord(answer) ? { ...answer, model: candidate.id } : {};
    respondJson(res, 200, finalAnswer, extraHeaders);
    return;
  }

  respondJson(res, 502, openAIError('All free model candidates refused or failed', 'upstream_error', null));
}

async function handleMessagesRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null) {
    return respondJson(res, 400, anthropicError('invalid_request_error', 'the request body is not one JSON object'));
  }

  const requirements = determineRequirements(body);
  const candidates = selectCandidates(requirements);
  if (candidates.length === 0) {
    return respondJson(res, 503, anthropicError('overloaded_error', 'no free model in the brief meets this request'));
  }

  const failures: UpstreamFailure[] = [];

  for (const candidate of candidates) {
    let upstreamRes: Response;
    try {
      upstreamRes = await dialGateway(candidate.id, anthropicToOpenAI(body, candidate.id));
    } catch {
      cooldownModels.add(candidate.id);
      failures.push({ status: 502, code: 'api_error', model: candidate.id });
      continue;
    }

    if (!upstreamRes.ok || upstreamRes.body === null) {
      await upstreamRes.text().catch(() => '');
      cooldownModels.add(candidate.id);
      failures.push({ status: upstreamRes.status, code: 'refusal', model: candidate.id });
      log(`failover: ${candidate.id} failed HTTP ${upstreamRes.status}, switching candidate...`);
      continue;
    }

    const extraHeaders: Record<string, string> = {};
    if (failures.length > 0) {
      extraHeaders['x-makefun-upstream-failures'] = JSON.stringify(failures.slice(0, 8));
    }

    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...extraHeaders,
      });
      try {
        for await (const event of anthropicEventsRelay(upstreamRes.body, candidate.id)) {
          res.write(event);
        }
      } finally {
        res.end();
      }
      return;
    }

    const answer: unknown = await upstreamRes.json().catch(() => ({}));
    const converted = openAIToAnthropic(isRecord(answer) ? answer : {}, candidate.id);
    respondJson(res, 200, converted, extraHeaders);
    return;
  }

  respondJson(res, 502, anthropicError('api_error', 'All free model candidates refused or failed'));
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    handleModelsRoute(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await handleChatRoute(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await handleMessagesRoute(req, res);
    return;
  }
  const isAnthropic = url.pathname === '/v1/messages';
  respondJson(
    res,
    404,
    isAnthropic ? anthropicError('not_found', `no route ${req.method ?? ''} ${url.pathname}`) : openAIError(`no route ${req.method ?? ''} ${url.pathname}`, 'not_found', null),
  );
}

// Lifecycle and Startup
function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

async function registerWithEnv(port: number): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`POST ${ENV_URL}/register failed HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') {
    log(`Registered with env: ${reply.requests} prompts in trial`);
  }
}

function startWorkPoller(server: Server): void {
  let inFlight = false;
  const interval = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const data: unknown = await res.json();
        if (isRecord(data) && data.done === true) {
          clearInterval(interval);
          server.close();
          process.exit(0);
        }
      } catch {
        // Retry next interval
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function run(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    const doc = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(doc, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');

  const server = createServer((req, res) => {
    void dispatch(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        respondJson(res, 500, openAIError('Server error', 'internal_error', null));
      }
    });
  });

  await listen(server);
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('Failed to bind server port');
  const port = addr.port;
  if (port === 8080) throw new Error('OS assigned port 8080 which belongs to env');

  log(`Listening on 0.0.0.0:${port} serving ${freeModelsList().length} free models`);
  await registerWithEnv(port);

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  startWorkPoller(server);
}

try {
  await run();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
