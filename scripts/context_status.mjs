import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const opts = {
    detailed: false,
    transcriptPath: '',
    warnThreshold: 120000,
    contextWindow: 200000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--detailed' || arg === '-Detailed') {
      opts.detailed = true;
    } else if ((arg === '--transcript' || arg === '-TranscriptPath') && i + 1 < argv.length) {
      opts.transcriptPath = argv[++i];
    } else if ((arg === '--warn-threshold' || arg === '-WarnThreshold') && i + 1 < argv.length) {
      const v = parseInt(argv[++i], 10);
      if (Number.isFinite(v) && v > 0) opts.warnThreshold = v;
    } else if ((arg === '--context-window' || arg === '-ContextWindow') && i + 1 < argv.length) {
      const v = parseInt(argv[++i], 10);
      if (Number.isFinite(v) && v > 0) opts.contextWindow = v;
    }
  }
  return opts;
}

function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return `${(v / 1000000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function buildMeter(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  let filled = Math.round((clamped / 100) * 10);
  if (clamped > 0 && filled === 0) filled = 1;
  const empty = 10 - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let hookEvent = '';
  let convId = '';
  let invocationNum = -1;
  let transcriptPath = opts.transcriptPath;

  try {
    if (!opts.detailed) {
      const rawInput = (await readStdin()).replace(/^\uFEFF/, '').trim();
      if (!rawInput) {
        process.stdout.write('{}\n');
        return;
      }
      const payload = JSON.parse(rawInput);
      transcriptPath = payload.transcriptPath || '';
      if (payload.hookEventName != null) hookEvent = String(payload.hookEventName);
      if (payload.conversationId != null) convId = String(payload.conversationId);
      if (payload.invocationNum != null) invocationNum = parseInt(String(payload.invocationNum), 10);
    }

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      process.stdout.write(opts.detailed ? `Transcript not found: ${transcriptPath}\n` : '{}\n');
      return;
    }

    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    let lines = raw.split(/\r?\n/);
    if (!opts.detailed && lines.length > 250) {
      lines = lines.slice(-250);
    }

    const plannerSteps = [];
    let userTurns = 0;
    let totalOutputTokens = 0;

    for (const line of lines) {
      if (!line || !line.trim()) continue;
      if (line.includes('"USER_INPUT"')) userTurns++;
      if (line.includes('"PLANNER_RESPONSE"') && line.includes('"input_tokens"')) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'PLANNER_RESPONSE' && obj.input_tokens != null) {
            const inTok = Number(obj.input_tokens) || 0;
            const cacheTok = Number(obj.cache_read_tokens) || 0;
            const outTok = Number(obj.output_tokens) || 0;
            const hasTools = Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0;
            totalOutputTokens += outTok;
            plannerSteps.push({
              Step: Number(obj.step_index) || 0,
              Model: obj.model || null,
              Input: inTok,
              CacheRead: cacheTok,
              TotalCtx: inTok + cacheTok,
              Output: outTok,
              HasTools: hasTools,
              Timestamp: obj.created_at || null,
            });
          }
        } catch {}
      }
    }

    if (plannerSteps.length === 0) {
      process.stdout.write(opts.detailed ? 'No model calls recorded in this conversation yet.\n' : '{}\n');
      return;
    }

    const latest = plannerSteps[plannerSteps.length - 1];
    const totalCtx = latest.TotalCtx;
    const cachePct = totalCtx > 0 ? Math.round((1000 * latest.CacheRead) / totalCtx) / 10 : 0;
    const ctxPct = opts.contextWindow > 0 ? Math.round((1000 * totalCtx) / opts.contextWindow) / 10 : 0;

    if (opts.detailed) {
      const result = {
        model: latest.Model,
        currentContextTotal: totalCtx,
        currentContextLabel: formatTokens(totalCtx),
        contextWindow: opts.contextWindow,
        contextPercent: ctxPct,
        uncachedInputTokens: latest.Input,
        cacheReadTokens: latest.CacheRead,
        cacheHitPercent: cachePct,
        lastOutputTokens: latest.Output,
        cumulativeOutput: totalOutputTokens,
        userTurns,
        modelCalls: plannerSteps.length,
        compactSuggested: totalCtx >= opts.warnThreshold,
        recentSteps: plannerSteps.slice(-6),
      };
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (hookEvent === 'PreInvocation' && invocationNum > 0) {
      process.stdout.write('{}\n');
      return;
    }

    if (totalCtx < opts.warnThreshold) {
      process.stdout.write('{}\n');
      return;
    }

    const safeConv = (convId || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
    const stateFile = path.join(os.tmpdir(), `agy_context_monitor_${safeConv}.txt`);
    let lastReported = -1;
    try {
      if (fs.existsSync(stateFile)) {
        const parsed = parseInt(fs.readFileSync(stateFile, 'utf-8').trim(), 10);
        if (Number.isFinite(parsed)) lastReported = parsed;
      }
    } catch {}

    if (latest.Step <= lastReported) {
      process.stdout.write('{}\n');
      return;
    }
    try {
      fs.writeFileSync(stateFile, String(latest.Step), 'ascii');
    } catch {}

    const ctxLabel = formatTokens(totalCtx);
    const outLabel = formatTokens(latest.Output);
    const meter = buildMeter(ctxPct);
    const winLabel = formatTokens(opts.contextWindow);
    const badge = `\uD83D\uDD34 \`${meter}\` **${ctxLabel} / ${winLabel}** (${ctxPct}% \u00B7 HEAVY) \u00B7 cache **${cachePct}%** \u00B7 out ${outLabel} \u00B7 **Consider running \`/compact\`** \u00B7 [HUD](sidecar://context-monitor/hud/)`;

    const response = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: badge,
          },
        },
      ],
    };

    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (err) {
    process.stdout.write(opts.detailed ? `Error reading transcript: ${err.message}\n` : '{}\n');
  }
}

main();
