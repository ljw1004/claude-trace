#!/usr/bin/env bun

import {
  mkdirSync,
  readFileSync,
  appendFileSync,
  renameSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(homedir(), 'claude-trace');

const PREAMBLE = `<!DOCTYPE html>
<html>
<head>
    <style>
        body {font-family: system-ui, -apple-system, sans-serif; margin: 0;}
        body>details {margin-top: 1ex; padding-top: 1ex; border-top: 1px solid lightgray;}
        details {position: relative; padding-left: 1.25em;}
        summary {list-style: none; cursor: pointer;}
        summary::-webkit-details-marker {display: none;}
        summary::before {content: '▷';position: absolute;left: 0;color: #666;}
        details[open]>summary::before {content: '▽';}
        details>div {margin-left: 1.25em;}
        details[open]>summary output {display: none;}
    </style>
    <script src="viewer.js"></script>
    <script>
        if (window.buildNode === undefined) {
          // {viewer.js}
        }
    </script>
</head>
<body>
</body>
</html>
${'<!' + '--'}
`;

/** Mutable global state: maps OpenCode session ids to the html logfile path for that session. */
const files = new Map<string, string>();

/** Mutable global state: maps `session\nmethod\nurl\nrequest\nmeta|real` to the previous raw request body used as the delta base. */
const prevs = new Map<string, object>();

/** Mutable global state: maps OpenCode session ids to the next per-session fetch sequence number. */
const ids = new Map<string, number>();

/** The unpatched global fetch for this module instance. */
const fetch0 = globalThis.fetch.bind(globalThis);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

type StreamEvent = {event: string | undefined; data: unknown};

/** Given two objects, returns their shallow merge, else just returns the right-hand side. */
function merge(a: unknown, b: unknown): unknown {
  if (!isRecord(a) || !isRecord(b)) {
    return b;
  }
  return {...a, ...b};
}

/**
 * Given two json values, returns a bool for whether they are identical, plus a
 * (lossy) representation of the difference intended for humans to read, which
 * still roughly captures the shape even of unchanged objects.
 *
 * The representation always has the same type as `next`.
 *
 * For changed lists, the representation is either the full new list, or, when shorter,
 * `[changedRecords, '...', additions, '---', removals]`.
 *
 * For dicts, removed keys appear as `-k: null`, added keys as `+k: v`, and changed keys as
 * `*k: v`. If a changed dict field is itself a compact list diff, that is rendered as
 * `k+: [...]` and `k-: [...]` for readability.
 */
function delta(prev: unknown, next: unknown): [unknown, boolean] {
  const hash = (v: unknown): string => {
    const sort = (v: unknown): unknown => {
      if (isArray(v)) {
        return v.map(sort);
      }
      if (!v || typeof v !== 'object') {
        return v;
      }
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map(k => [k, sort((v as Record<string, unknown>)[k])]),
      );
    };
    return Bun.hash(JSON.stringify(sort(v))).toString(16);
  };
  if (isRecord(prev) && isRecord(next)) {
    // RECORDS: Overall resulting record is just {"[repeat]":"[repeat]"} if it's unchanged. This is the only case
    // where the result has a different structure from the input (well it's still a record, just with keys lost).
    // Otherwise the result is a record with
    // - `{"-k":null}` for keys that were in prev but absent in next
    // - `{"+k":v}` for keys that were absent in prev and present in next
    // - `{"k":v}` for keys present in both, and v is unchanged in prev and next, and fairly short
    //    - `{"k":["..."]}` for keys present in both, and v is an unchanged longish array
    //    - `{"k":{"[unchanged]":"[unchanged]"}}` for keys present in both, and v is an unchanged longish object
    //    - `{"k":"[unchanged]"}` for keys present in both, and v is an unchanged longish string
    //    - `{"k":v}` for keys present in both, and v is an unchanged longish anything else
    // - `{"*k":v}` for keys present in both, and v is a changed non-record non-array
    // - `{"*k":delta}` for keys present in both, and v is a changed record
    // - `{"*k":[...v]}` for keys present in both, and v is a changed array best represented as new array, or changes followed by remainder, or changes followed by adds+dels
    // - `{"k+":[...adds], "k-":[...dels]}` for keys present in both, and v is a changed array best represented just with adds and dels (skip either if absent)
    let isSame = true;
    const out: Record<string, unknown> = {};
    const prevKeys = new Set(Object.keys(prev));
    const nextKeys = new Set(Object.keys(next));
    for (const k of [...prevKeys].filter(k => !nextKeys.has(k)).sort()) {
      out[`-${k}`] = null;
      isSame = false;
    }
    for (const k of [...nextKeys].filter(k => !prevKeys.has(k)).sort()) {
      out[`+${k}`] = next[k];
      isSame = false;
    }
    for (const k of [...prevKeys].filter(k => nextKeys.has(k)).sort()) {
      const [sub, same] = delta(prev[k], next[k]);
      if (same) {
        const raw = JSON.stringify(next[k]);
        out[k] =
          raw.length < 128
            ? next[k]
            : isArray(next[k])
              ? ['...']
              : isRecord(next[k])
                ? {'[unchanged]': '[unchanged]'}
                : typeof next[k] === 'string'
                  ? '[unchanged]'
                  : next[k];
        continue;
      }
      isSame = false;
      if (!isArray(sub) || (sub[0] !== '...' && sub[0] !== '---')) {
        out[`*${k}`] = sub;
        continue;
      }
      const cut = sub.findIndex(item => item === '---');
      const cut2 = cut === -1 ? undefined : cut;
      const add = cut2 === 0 ? [] : cut2 == null ? sub.slice(1) : sub.slice(1, cut2);
      const del = cut2 == null ? [] : sub.slice(cut2 + 1);
      if (del.length > 0) {
        out[`${k}-`] = del;
      }
      if (add.length > 0) {
        out[`${k}+`] = add;
      }
    }
    return isSame ? [{'[repeat]': '[repeat]'}, true] : [out, false];
  } else if (isArray(prev) && isArray(next)) {
    // ARRAYS: Overall resulting array is `[...changedRecordsPrefix, "...", ...adds, "---", ...dels]`
    // or, if more compact, `[...changedRecordsPrefix, ...nextRemainder]`
    // - The adds/dels themselves have a greedy algorithm: in prev=[c,d,e,f] next=[d,e,c] then we greedily match c, hence adds=[d,e] and dels=[d,e,f]
    // - The changedRecordsPrefix deliberately skips identical record elements, just like identical non-array elements get skipped too
    const changedRecordsPrefix: Array<unknown> = [];
    let shownEllipsis = false;
    let i = 0;
    for (; i < prev.length && i < next.length; i++) {
      if (!isRecord(prev[i]) || !isRecord(next[i])) {
        break;
      }
      const [elDif, elIsSame] = delta(prev[i], next[i]);
      if (elIsSame && !shownEllipsis) {
        changedRecordsPrefix.push('...*');
        shownEllipsis = true;
      }
      if (!elIsSame) {
        changedRecordsPrefix.push(elDif);
      }
    }
    const left: Array<readonly [unknown, string]> = prev.slice(i).map(v => [v, hash(v)] as const);
    let right: Array<readonly [unknown, string]> = next.slice(i).map(v => [v, hash(v)] as const);
    const add: unknown[] = [];
    const del: unknown[] = [];
    for (const [value, hash] of left) {
      const ix = right.findIndex(item => item[1] === hash);
      if (ix === -1) {
        del.push(value);
        continue;
      }
      add.push(...right.slice(0, ix).map(item => item[0]));
      right = right.slice(ix + 1);
    }
    add.push(...right.map(item => item[0]));
    if (add.length === 0 && del.length === 0) {
      return [
        [...changedRecordsPrefix, ...next.slice(i)],
        changedRecordsPrefix.length === 0 || (changedRecordsPrefix.length === 1 && shownEllipsis),
      ];
    }
    const additionalEllipsis = shownEllipsis ? [] : ['...'];
    if (add.length + del.length < next.length - i) {
      return del.length === 0
        ? [[...changedRecordsPrefix, ...additionalEllipsis, ...add], false]
        : add.length === 0
          ? [[...changedRecordsPrefix, '---', ...del], false]
          : [[...changedRecordsPrefix, ...additionalEllipsis, ...add, '---', ...del], false];
    }
    return [[...changedRecordsPrefix, ...next.slice(i)], false];
  } else {
    // PRIMITIVES: Overall resulting primitive is just `next`, the new value itself.
    return [next, prev === next];
  }
}

/**
 * Appends one row to the session logfile. If logging fails, them skips silently.
 * Session logfiles are like `~/claude-trace/2024.6.10 15.30.45 why is the sky blue.html`
 * In the vanishingly rare case of filename collision (because a user asked two different sessions
 * the same prompt at the exact same second) then there'll be a clash, and that's the user's fault:
 * we tradeoff theoretical perfection for user convenience in the common case.
 */
function writeNoThrow(id: string, name: string | undefined, row: Record<string, unknown>): void {
  try {
    const prev = files.get(id);
    const d = new Date();
    const file =
      prev !== undefined && (name === undefined || !prev.endsWith('[transcript].html'))
        ? prev
        : join(
            root,
            `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${d.getHours()}.${d.getMinutes()}.${d.getSeconds()} ${name ?? '[transcript]'}.html`,
          );
    mkdirSync(root, {recursive: true});
    if (prev === undefined) {
      const html = PREAMBLE.replace('// {viewer.js}', () =>
        readFileSync(new URL('./viewer.js', import.meta.url), 'utf8'),
      );
      appendFileSync(file, html);
    } else if (prev !== file) {
      renameSync(prev, file);
    }
    files.set(id, file);
    appendFileSync(file, `${JSON.stringify(row).replace(/-->/g, '--\\u003e')}\n`);
  } catch {
    // Intentionally swallow tracing I/O failures so plugin logging can't crash OpenCode.
  }
}

/**
 * This recognizes the format used by Anthropic LLM event streams
 * The event-streams used by OpenAI are different.
 */
function isAnthropicEvents(events: StreamEvent[]): boolean {
  const v = events[0]?.data;
  return (
    isRecord(v) &&
    typeof v.type === 'string' &&
    (v.type === 'message_start' || v.type === 'content_block_start')
  );
}

/** Given parsed Anthropic events, reconstructs the final message json. */
function parseAnthropicEvents(list: StreamEvent[]): Record<string, unknown> {
  let base: Record<string, unknown> = {type: 'message', role: 'assistant'};
  const blocks = new Map<number, Record<string, unknown>>();
  const json = new Map<number, string>();
  for (const row of list) {
    if (!isRecord(row.data) || typeof row.data.type !== 'string') {
      continue;
    }
    if (row.data.type === 'message_start' && isRecord(row.data.message)) {
      base = {...base, ...row.data.message};
      continue;
    }
    if (
      row.data.type === 'content_block_start' &&
      typeof row.data.index === 'number' &&
      isRecord(row.data.content_block)
    ) {
      blocks.set(row.data.index, {...row.data.content_block});
      continue;
    }
    if (
      row.data.type === 'content_block_delta' &&
      typeof row.data.index === 'number' &&
      isRecord(row.data.delta)
    ) {
      const prev = blocks.get(row.data.index) ?? {type: 'text', text: ''};
      if (row.data.delta.type === 'text_delta') {
        blocks.set(row.data.index, {
          ...prev,
          text: `${typeof prev.text === 'string' ? prev.text : ''}${typeof row.data.delta.text === 'string' ? row.data.delta.text : ''}`,
        });
      }
      if (row.data.delta.type === 'input_json_delta') {
        json.set(
          row.data.index,
          `${json.get(row.data.index) ?? ''}${typeof row.data.delta.partial_json === 'string' ? row.data.delta.partial_json : ''}`,
        );
      }
      continue;
    }
    if (row.data.type === 'message_delta') {
      if (isRecord(row.data.delta)) {
        base = {...base, ...row.data.delta};
      }
      if (isRecord(row.data.usage)) {
        base.usage = merge(base.usage, row.data.usage);
      }
      continue;
    }
    if (isRecord(row.data.usage)) {
      base.usage = merge(base.usage, row.data.usage);
    }
  }
  const content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ix, block]) => {
      if (block.type !== 'tool_use' || !json.has(ix)) {
        return block;
      }
      const raw = json.get(ix) ?? '';
      try {
        return {...block, input: JSON.parse(raw) as unknown};
      } catch {
        return {...block, input: raw};
      }
    });
  return {...base, content};
}

/**
 * Bedrock InvokeModelWithResponseStream returns AWS EventStream frames whose JSON payloads
 * contain a base64 `bytes` field. For Anthropic models, those decoded bytes are the same
 * event JSON objects that Anthropic SSE would have put in `data: ...` lines.
 *
 * AWS EventStream frames are: total byte length, headers byte length, prelude CRC,
 * headers, payload, message CRC. Length fields are big-endian u32s. We only need
 * the payload bytes here; structural validation is enough to distinguish this
 * from normal JSON/SSE response bodies.
 */
function tryParseAsBedrock(body: Uint8Array): StreamEvent[] | undefined {
  if (body.length < 16) {
    return undefined;
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const textDecoder = new TextDecoder();
  const out: StreamEvent[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (body.length - offset < 16) {
      return undefined;
    }
    const totalLength = view.getUint32(offset);
    const headersLength = view.getUint32(offset + 4);
    if (
      totalLength < 16 ||
      headersLength > totalLength - 16 ||
      offset + totalLength > body.length
    ) {
      return undefined;
    }
    const payloadStart = offset + 12 + headersLength;
    const payloadEnd = offset + totalLength - 4;
    const payload = body.subarray(payloadStart, payloadEnd);
    let wrapper: unknown;
    try {
      wrapper = JSON.parse(textDecoder.decode(payload)) as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(wrapper)) {
      return undefined;
    }
    if (typeof wrapper.bytes !== 'string') {
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.from(wrapper.bytes, 'base64').toString('utf8')) as unknown;
    } catch {
      return undefined;
    }
    out.push({
      event: isRecord(data) && typeof data.type === 'string' ? data.type : undefined,
      data,
    });
    offset += totalLength;
  }
  return out.length > 0 ? out : undefined;
}

function tryParseAsRaw(body: Uint8Array): StreamEvent[] | undefined {
  const textDecoder = new TextDecoder();
  const text = textDecoder.decode(body);
  const out: StreamEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) {
      continue;
    }
    let name: string | undefined;
    const data = block
      .split(/\r?\n/)
      .flatMap(line => {
        if (line.startsWith('event:')) {
          name = line.slice(6).trim();
          return [];
        }
        if (line.startsWith('data:')) {
          return [line.slice(5).trimStart()];
        }
        return [];
      })
      .join('\n');
    if (!data || data === '[DONE]') {
      continue;
    }
    try {
      out.push({event: name, data: JSON.parse(data) as unknown});
    } catch {
      return undefined;
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Given a raw response body and url, returns the final json to log.
 */
function responseAsJson(body: ArrayBuffer, url: string): Record<string, unknown> {
  const bytes = new Uint8Array(body);

  // Plain json is returned directly
  const textDecoder = new TextDecoder();
  const text = textDecoder.decode(bytes);
  try {
    const asJson = JSON.parse(text) as unknown;
    if (isRecord(asJson)) {
      return asJson;
    }
  } catch {
    // expected to fall through in case of streaming formats, below
  }

  const path = ((): string => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();

  // We can reconstruct streaming formats of AWS-Bedrock and SSE (used by Anthropic, OpenAI, Vertex, ...)
  const events =
    (path.endsWith('/invoke-with-response-stream') ? tryParseAsBedrock(bytes) : undefined) ??
    (path.endsWith('/messages') /* anthropic */ || path.endsWith(':streamRawPredict') /* vertex */
      ? tryParseAsRaw(bytes)
      : undefined) ??
    undefined;

  // We can parse the events sent by Anthropic LLMs
  if (events && isAnthropicEvents(events)) {
    return parseAnthropicEvents(events);
  }

  // In case of error, just the raw response
  return {_body: text};
}

function isSuggestionModeRequest(raw: Record<string, unknown>): boolean {
  const messages = raw.messages;
  if (!isArray(messages)) {
    return false;
  }
  const last = messages.at(-1);
  if (!isRecord(last) || last.role !== 'user') {
    return false;
  }
  const content = last.content;
  if (typeof content === 'string') {
    return content.startsWith('[SUGGESTION MODE:');
  }
  if (!isArray(content)) {
    return false;
  }
  return content.some(
    part =>
      isRecord(part) &&
      part.type === 'text' &&
      typeof part.text === 'string' &&
      part.text.startsWith('[SUGGESTION MODE:'),
  );
}

/** Returns a sanitized logfile title from Claude's explicit title-generation response. */
function extractTitleFromResponse(v: Record<string, unknown>): string | undefined {
  if (v.type !== 'message' || v.role !== 'assistant') {
    return undefined;
  }
  if (!isArray(v.content) || v.content.length !== 1) {
    return undefined;
  }
  const [part] = v.content;
  if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(part.text) as unknown;
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).join('\n') !== 'title' ||
      typeof parsed.title !== 'string'
    ) {
      return undefined;
    }
    return (
      parsed.title
        .replace(/[^A-Za-z0-9 _-]+/g, ' ')
        .trim()
        .split(/\s+/)
        .slice(0, 10)
        .join(' ')
        .slice(0, 50)
        .trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Intercepts Anthropic LLM fetches and logs request/response rows.
 * Side effects: mutates `prevs`, mutates `ids`, and writes logs to disk.
 */
async function tracedFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): Promise<Response> {
  const now = (): string => new Date().toISOString();
  const error = (err: unknown): {_error: string; _stack?: string} =>
    err instanceof Error
      ? err.stack === undefined
        ? {_error: err.message}
        : {_error: err.message, _stack: err.stack}
      : {_error: String(err)};

  const req =
    input instanceof Request
      ? new Request(input, init)
      : new Request(input instanceof URL ? input.href : input, init);

  const session = req.headers.get('x-claude-code-session-id') ?? undefined;
  if (session === undefined) {
    return fetch0(req);
  }

  const text = await req
    .clone()
    .text()
    .catch(() => '');
  const raw = ((): Record<string, unknown> => {
    try {
      const body = JSON.parse(text) as unknown;
      return isRecord(body) ? body : {_body: text};
    } catch {
      return {_body: text};
    }
  })();
  const purpose =
    Array.isArray(raw.tools) && raw.tools.length > 0 && !isSuggestionModeRequest(raw)
      ? ''
      : '[meta]';
  // The purpose field is "[meta]" for LLM requests that appear to be not part of the conversation, e.g. "generate a title".
  // I tried a bunch of heuristics, and this one "no tools, plus suggestion mode" was the one that worked best across a variety of models.
  // We calculate it here based on the request, and store it on both request and response, since otherwise
  // there are no reliable indicators on the response jsonl for our viewer to key off.
  const seq = (ids.get(session) ?? 0) + 1;
  ids.set(session, seq);
  const common = {_id: seq, _purpose: purpose, _url: req.url};
  const requestKey = `${session}\n${req.method}\n${req.url}\nrequest\n${purpose}`;
  const requestNext = raw as object;
  const [requestRow] = delta(prevs.get(requestKey), requestNext);
  prevs.set(requestKey, requestNext);
  writeNoThrow(session, undefined, {
    ...(requestRow as Record<string, unknown>),
    ...common,
    _kind: 'request',
    _ts: now(),
  });

  const res = await fetch0(input, init).catch((err: unknown) => {
    writeNoThrow(session, undefined, {
      ...common,
      _kind: 'error',
      _ts: now(),
      ...error(err),
    });
    throw err;
  });
  // We'll register background processing of the response, once it comes. But return 'res' immediately.
  void res
    .clone()
    .arrayBuffer()
    .then(body => {
      const json = responseAsJson(body, req.url);
      const detail =
        isRecord(json) && isRecord(json.error) && typeof json.error.message === 'string'
          ? json.error.message
          : isRecord(json) && typeof json.error === 'string'
            ? json.error
            : `${res.status} ${res.statusText}`;
      const responseNext = (
        !res.ok
          ? {...json, _status: res.status, _status_text: res.statusText, _error: detail}
          : json
      ) as object;
      writeNoThrow(session, extractTitleFromResponse(json), {
        ...(responseNext as Record<string, unknown>),
        ...common,
        _kind: 'response',
        _ts: now(),
      });
    })
    .catch((err: unknown) => {
      writeNoThrow(session, undefined, {
        ...common,
        _kind: 'error',
        _ts: now(),
        ...error(err),
      });
    });
  return res;
}

if (import.meta.main) {
  // Normal invocation: invoke `BUN_OPTIONS=--preload=thisScript.ts claude`
  const path = (process.env.PATH ?? '')
    .split(delimiter)
    .map(d => resolve(d, 'claude'))
    .map(p => (existsSync(p) ? p : undefined))
    .filter(p => !!p)[0];
  if (path === undefined) {
    throw new Error('claude not found on PATH');
  }
  const thisScript = realpathSync(fileURLToPath(import.meta.url));
  if (/\s/.test(thisScript)) {
    throw new Error('claude-trace path must not contain whitespace when used with BUN_OPTIONS');
  }
  if (process.env.BUN_OPTIONS !== undefined) {
    throw new Error('claude-trace is incompatible with BUN_OPTIONS');
  }
  const proc = Bun.spawn({
    cmd: [path, ...process.argv.slice(2)],
    env: {
      ...process.env,
      BUN_OPTIONS: `--preload=${thisScript}`,
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(await proc.exited);
} else {
  // Preload invocation: intercept fetch
  delete process.env.BUN_OPTIONS;
  globalThis.fetch = tracedFetch as typeof fetch;
}
