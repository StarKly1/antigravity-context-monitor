import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = '127.0.0.1';
const PORT = (() => {
  const raw = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isNaN(parsed) ? 8000 : parsed;
})();

const TOKEN =
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN ||
  '';

const DEFAULT_CONV_ID = process.env.ANTIGRAVITY_CONVERSATION_ID || '';

function getAppDataDir() {
  const envDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

function isSafeId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{4,128}$/.test(id.trim());
}

function findTranscript(convId) {
  const brainDir = path.join(getAppDataDir(), 'brain');
  if (isSafeId(convId)) {
    const direct = path.join(brainDir, convId.trim(), '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(direct)) {
      return { convId: convId.trim(), transcriptPath: direct, autoTracked: false };
    }
  }

  // Fallback: pick the most recently updated transcript in brain/
  try {
    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    let best = null;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const candidate = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && (!best || stat.mtimeMs > best.mtimeMs)) {
          best = { convId: entry.name, transcriptPath: candidate, mtimeMs: stat.mtimeMs };
        }
      } catch {}
    }
    if (best) return { convId: best.convId, transcriptPath: best.transcriptPath, autoTracked: true };
  } catch {}

  if (isSafeId(DEFAULT_CONV_ID)) {
    const fallback = path.join(brainDir, DEFAULT_CONV_ID.trim(), '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(fallback)) {
      return { convId: DEFAULT_CONV_ID.trim(), transcriptPath: fallback, autoTracked: true };
    }
  }

  return null;
}

const FIVE_HOURS_MS = 5 * 3600 * 1000;
const SEVEN_DAYS_MS = 7 * 86400 * 1000;
const WINDOWS_CACHE_TTL_MS = 15000;

/** @type {Map<string, { mtimeMs: number, records: Array<{ tsMs: number, modelFamily: string, uncachedInput: number, cacheRead: number, output: number, isSubagent: boolean }> }>} */
const transcriptCache = new Map();
let usageWindowsCache = { computedAtMs: 0, anchorsKey: '', data: null };

export function classifyModelFamily(model) {
  if (typeof model !== 'string' || !model) return 'other';
  if (/argon/i.test(model)) return 'argon';
  if (/gemini/i.test(model)) return 'gemini';
  if (/claude|gpt|openai|\bo1\b|\bo3\b|\bo4\b/i.test(model)) return 'claude_gpt';
  return 'other';
}

function parseTranscriptRecords(filePath) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const isSubagent = !raw.includes('"USER_EXPLICIT"');
  const lines = raw.split(/\r?\n/);
  const records = [];

  for (const line of lines) {
    if (!line || !line.includes('"PLANNER_RESPONSE"') || !line.includes('"input_tokens"')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'PLANNER_RESPONSE' || obj.input_tokens == null) continue;
      const tsMs = obj.created_at ? Date.parse(obj.created_at) : NaN;
      if (!Number.isFinite(tsMs)) continue;
      records.push({
        tsMs,
        modelFamily: classifyModelFamily(obj.model),
        uncachedInput: Number(obj.input_tokens) || 0,
        cacheRead: Number(obj.cache_read_tokens) || 0,
        output: Number(obj.output_tokens) || 0,
        isSubagent,
      });
    } catch {}
  }

  return records;
}

export function parseAnchorsParam(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const key of ['gemini', 'argon', 'claude_gpt']) {
      const entry = parsed[key];
      if (!entry || typeof entry !== 'object') continue;
      const h5ResetAt = Number(entry.h5ResetAt);
      const w7ResetAt = Number(entry.w7ResetAt);
      const clean = {};
      if (Number.isFinite(h5ResetAt) && h5ResetAt > 0) clean.h5ResetAt = h5ResetAt;
      if (Number.isFinite(w7ResetAt) && w7ResetAt > 0) clean.w7ResetAt = w7ResetAt;
      if (clean.h5ResetAt || clean.w7ResetAt) out[key] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

function resolveWindowCycle(sortedRecords, now, windowMs, pinnedResetAt) {
  if (Number.isFinite(pinnedResetAt) && pinnedResetAt > 0) {
    if (now < pinnedResetAt) {
      const cycleEnd = Math.min(pinnedResetAt, now + windowMs);
      return { cycleStart: cycleEnd - windowMs, cycleEnd, active: true, pinned: true };
    }
    // Pinned cycle has expired; start next fixed-epoch cycle from first call at/after pinnedResetAt
    let cycleStart = 0;
    for (const rec of sortedRecords) {
      if (rec.tsMs < pinnedResetAt) continue;
      if (!cycleStart || rec.tsMs >= cycleStart + windowMs) {
        cycleStart = rec.tsMs;
      }
    }
    const cycleEnd = cycleStart ? cycleStart + windowMs : 0;
    return { cycleStart, cycleEnd, active: cycleStart > 0 && now < cycleEnd, pinned: false };
  }

  // Reconstruct Antigravity's fixed-epoch cycle (starts on the first call
  // when no cycle is active, lasts windowMs, then resets completely).
  let cycleStart = 0;
  for (const rec of sortedRecords) {
    if (!cycleStart || rec.tsMs >= cycleStart + windowMs) {
      cycleStart = rec.tsMs;
    }
  }
  const cycleEnd = cycleStart ? cycleStart + windowMs : 0;
  return { cycleStart, cycleEnd, active: cycleStart > 0 && now < cycleEnd, pinned: false };
}

export function aggregatePoolFixedCycles(records, now, anchor = null) {
  const sorted = records.length > 1 ? [...records].sort((a, b) => a.tsMs - b.tsMs) : [...records];

  const h5 = resolveWindowCycle(sorted, now, FIVE_HOURS_MS, anchor?.h5ResetAt);
  const w7 = resolveWindowCycle(sorted, now, SEVEN_DAYS_MS, anchor?.w7ResetAt);

  let h5Tokens = 0, h5TotalWithCache = 0, h5Calls = 0, h5Sub = 0;
  let w7Tokens = 0, w7TotalWithCache = 0, w7Calls = 0, w7Sub = 0;

  for (const rec of sorted) {
    const billed = rec.uncachedInput + rec.output;
    const totalWithCache = billed + rec.cacheRead;

    if (w7.active && rec.tsMs >= w7.cycleStart && rec.tsMs < w7.cycleEnd) {
      w7Tokens += billed;
      w7TotalWithCache += totalWithCache;
      w7Calls += 1;
      if (rec.isSubagent) w7Sub += 1;
    }

    if (h5.active && rec.tsMs >= h5.cycleStart && rec.tsMs < h5.cycleEnd) {
      h5Tokens += billed;
      h5TotalWithCache += totalWithCache;
      h5Calls += 1;
      if (rec.isSubagent) h5Sub += 1;
    }
  }

  return {
    h5Tokens,
    h5TotalWithCache,
    h5Calls,
    h5Sub,
    reset5hSec: h5.active ? Math.max(0, Math.floor((h5.cycleEnd - now) / 1000)) : 0,
    h5CycleEnd: h5.active ? h5.cycleEnd : 0,
    h5Pinned: h5.pinned,
    w7Tokens,
    w7TotalWithCache,
    w7Calls,
    w7Sub,
    reset7dSec: w7.active ? Math.max(0, Math.floor((w7.cycleEnd - now) / 1000)) : 0,
    w7CycleEnd: w7.active ? w7.cycleEnd : 0,
    w7Pinned: w7.pinned,
  };
}

function computeUsageWindows(anchors = {}) {
  const now = Date.now();
  const anchorsKey = JSON.stringify(anchors || {});
  if (
    usageWindowsCache.data &&
    usageWindowsCache.anchorsKey === anchorsKey &&
    now - usageWindowsCache.computedAtMs < WINDOWS_CACHE_TTL_MS
  ) {
    return usageWindowsCache.data;
  }

  const cutoff14d = now - 2 * SEVEN_DAYS_MS;
  const brainDir = path.join(getAppDataDir(), 'brain');

  const poolRecords = {
    gemini: [],
    argon: [],
    claude_gpt: [],
  };

  const seenPaths = new Set();

  try {
    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const filePath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > 2 * SEVEN_DAYS_MS) continue;

      seenPaths.add(filePath);
      let cached = transcriptCache.get(filePath);
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        cached = { mtimeMs: stat.mtimeMs, records: parseTranscriptRecords(filePath) };
        transcriptCache.set(filePath, cached);
      }

      for (const rec of cached.records) {
        if (rec.tsMs < cutoff14d) continue;
        const list = poolRecords[rec.modelFamily];
        if (list) list.push(rec);
      }
    }
  } catch {}

  // Prune stale cache entries older than 14 days
  for (const key of transcriptCache.keys()) {
    if (!seenPaths.has(key)) transcriptCache.delete(key);
  }

  const result = {
    updatedAt: new Date(now).toISOString(),
    gemini: aggregatePoolFixedCycles(poolRecords.gemini, now, anchors.gemini),
    argon: aggregatePoolFixedCycles(poolRecords.argon, now, anchors.argon),
    claude_gpt: aggregatePoolFixedCycles(poolRecords.claude_gpt, now, anchors.claude_gpt),
  };

  usageWindowsCache = { computedAtMs: now, anchorsKey, data: result };
  return result;
}

function parseMetrics(convId) {
  const found = findTranscript(convId);
  if (!found) {
    return {
      ok: true,
      hasData: false,
      conversationId: convId || null,
      model: null,
      currentContextTotal: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheHitPercent: 0,
      lastOutputTokens: 0,
      cumulativeOutput: 0,
      userTurns: 0,
      modelCalls: 0,
      lastCallAt: null,
      steps: [],
    };
  }

  let raw = '';
  try {
    raw = fs.readFileSync(found.transcriptPath, 'utf-8');
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const lines = raw.split(/\r?\n/);
  const steps = [];
  let userTurns = 0;
  let cumulativeOutput = 0;

  for (const line of lines) {
    if (!line) continue;
    if (line.includes('"USER_INPUT"')) {
      userTurns++;
    }
    if (line.includes('"PLANNER_RESPONSE"') && line.includes('"input_tokens"')) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'PLANNER_RESPONSE' && obj.input_tokens != null) {
          const input = Number(obj.input_tokens) || 0;
          const cacheRead = Number(obj.cache_read_tokens) || 0;
          const output = Number(obj.output_tokens) || 0;
          const totalCtx = input + cacheRead;
          cumulativeOutput += output;
          steps.push({
            step: obj.step_index,
            model: obj.model || null,
            input,
            cacheRead,
            totalCtx,
            output,
            cachePct: totalCtx > 0 ? Math.round((1000 * cacheRead) / totalCtx) / 10 : 0,
            timestamp: obj.created_at || null,
          });
        }
      } catch {}
    }
  }

  if (steps.length === 0) {
    return {
      ok: true,
      hasData: false,
      conversationId: found.convId,
      model: null,
      currentContextTotal: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheHitPercent: 0,
      lastOutputTokens: 0,
      cumulativeOutput: 0,
      userTurns,
      modelCalls: 0,
      lastCallAt: null,
      steps: [],
    };
  }

  const latest = steps[steps.length - 1];
  const totalCtx = latest.totalCtx;
  const cacheHitPercent = totalCtx > 0 ? Math.round((1000 * latest.cacheRead) / totalCtx) / 10 : 0;

  return {
    ok: true,
    hasData: true,
    conversationId: found.convId,
    autoTracked: Boolean(found.autoTracked),
    model: latest.model,
    currentContextTotal: totalCtx,
    uncachedInputTokens: latest.input,
    cacheReadTokens: latest.cacheRead,
    cacheHitPercent,
    lastOutputTokens: latest.output,
    cumulativeOutput,
    userTurns,
    modelCalls: steps.length,
    lastCallAt: latest.timestamp,
    steps: steps.slice(-14),
  };
}

let preloadCache = null;
function getPreloadJs() {
  if (preloadCache !== null) return preloadCache;
  try {
    const p = path.join(getAppDataDir(), 'lib', 'node_modules', 'sidecar_sdk', 'preload.js');
    preloadCache = fs.readFileSync(p, 'utf-8');
    return preloadCache;
  } catch {
    preloadCache = '// sidecar preload stub\n';
    return preloadCache;
  }
}

function injectQueryParams(html, token, convId) {
  if (!token && !convId) return html;
  const parts = [];
  if (token) parts.push(`token=${encodeURIComponent(token)}`);
  if (convId) parts.push(`conversationId=${encodeURIComponent(convId)}`);
  const qs = parts.join('&');
  return html.replace(/\b(href|src)=(["'])(\/[^"'\s>]*)\2/g, (match, attr, quote, url) => {
    if (url.startsWith('//')) return match;
    const [base, ...hashParts] = url.split('#');
    const hash = hashParts.length ? `#${hashParts.join('#')}` : '';
    const sep = base.includes('?') ? '&' : '?';
    return `${attr}=${quote}${base}${sep}${qs}${hash}${quote}`;
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');

  if ((req.method || 'GET').toUpperCase() === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const pathname = parsed.pathname || '/';

  if (pathname === '/preload.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(getPreloadJs());
    return;
  }

  if (pathname === '/' || pathname === '/index.html' || pathname === '/ui.html') {
    try {
      const uiPath = path.join(__dirname, 'ui.html');
      let html = fs.readFileSync(uiPath, 'utf-8');
      const token = parsed.searchParams.get('token')?.trim() || (typeof req.headers['x-sidecar-token'] === 'string' ? req.headers['x-sidecar-token'].trim() : '');
      const convId = parsed.searchParams.get('conversationId')?.trim() || '';
      html = injectQueryParams(html, token, convId);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Failed to load ui.html: ${err.message}`);
    }
    return;
  }

  if (pathname === '/api/metrics') {
    const convId = parsed.searchParams.get('conversationId')?.trim() || '';
    const anchors = parseAnchorsParam(parsed.searchParams.get('anchors') || '');
    const metrics = parseMetrics(convId);
    metrics.usageWindows = computeUsageWindows(anchors);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(metrics));
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  server.listen(PORT, HOST, () => {
    console.log(`[context-monitor-hud] listening on http://${HOST}:${PORT}`);
  });

  function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
