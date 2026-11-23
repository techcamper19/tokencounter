(() => {
  'use strict';

  const API_URL = 'https://openrouter.ai/api/v1/models';
  const STORAGE_KEYS = {
    cache: 'ts_openrouter_models_v3',
    pinned: 'ts_custom_pinned_v3',
    theme: 'ts_bento_theme_v3',
  };

  const SAMPLE_REPORT = `10M cached input
500,000 fresh input
50,000 output`;

  const FAMOUS_SLOTS = [
    { preferred: 'deepseek/deepseek-v4.1-flash', fallback: /^deepseek\/deepseek-v\d.*flash$/i, code: 'DS4', short: 'DeepSeek V4.1' },
    { preferred: 'anthropic/claude-haiku-5.5', fallback: /^anthropic\/claude-haiku/i, code: 'HAIKU', short: 'Haiku 5.5' },
    { preferred: 'google/gemini-4-hydrogen', fallback: /^google\/gemini-.*(hydrogen|flash)/i, code: 'GEM-H', short: 'Gemini H' },
    { preferred: 'anthropic/claude-sonnet-5.5', fallback: /^anthropic\/claude-sonnet/i, code: 'SONNET', short: 'Sonnet 5.5' },
    { preferred: 'openai/gpt-6.2-sol', fallback: /^openai\/gpt-\d.*sol$/i, code: 'SOL', short: 'GPT-6.2 Sol' },
    { preferred: 'google/gemini-4-neon', fallback: /^google\/gemini-.*(neon|pro)/i, code: 'NEON', short: 'Gemini Neon' },
    { preferred: 'anthropic/claude-opus-5.5', fallback: /^anthropic\/claude-opus/i, code: 'OPUS', short: 'Opus 5.5' },
    { preferred: 'openai/gpt-6.2-astra', fallback: /^openai\/gpt-\d.*astra$/i, code: 'ASTRA', short: 'GPT-6.2 Astra' },
  ];

  // State
  let allModels = [];
  let modelMap = new Map();
  let slotMetaMap = new Map();
  let famousIds = [];
  let customPinnedIds = [];
  let orderedRows = [];
  let selectedModelId = null;
  let cacheEnabled = true;
  let tokens = { cached: 0, fresh: 0, output: 0 };
  let parseMeta = {
    mode: 'empty', // 'empty' | 'exact' | 'combined' | 'estimated' | 'none' | 'manual'
    combinedInOut: 0,
    splitOutPct: 0, // 0 = all-in baseline (shows min–max range), >0 = user-chosen % split
    note: '',
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    refreshBtn: $('refreshBtn'),
    syncLabel: $('syncLabel'),
    openAllBtn: $('openAllBtn'),
    topCatalogCount: $('topCatalogCount'),
    clearOrSampleBtn: $('clearOrSampleBtn'),
    themeToggleBtn: $('themeToggleBtn'),
    cacheToggleBtn: $('cacheToggleBtn'),
    usageInput: $('usageInput'),
    parseStatus: $('parseStatus'),
    cachedField: $('cachedField'),
    freshField: $('freshField'),
    outputField: $('outputField'),
    barCached: $('barCached'),
    barFresh: $('barFresh'),
    barOutput: $('barOutput'),
    pctCached: $('pctCached'),
    pctFresh: $('pctFresh'),
    pctOutput: $('pctOutput'),
    savingsBig: $('savingsBig'),
    splitPaidFill: $('splitPaidFill'),
    splitPaidLabel: $('splitPaidLabel'),
    splitUncachedLabel: $('splitUncachedLabel'),
    splitLeftCap: $('splitLeftCap'),
    splitRightCap: $('splitRightCap'),
    prevModelBtn: $('prevModelBtn'),
    nextModelBtn: $('nextModelBtn'),
    stepperModelName: $('stepperModelName'),
    curveMaxLabel: $('curveMaxLabel'),
    curveMinLabel: $('curveMinLabel'),
    costCurveChart: $('costCurveChart'),
    selectedModelPill: $('selectedModelPill'),
    heroCost: $('heroCost'),
    heroRangeNote: $('heroRangeNote'),
    rateCached: $('rateCached'),
    rateFresh: $('rateFresh'),
    rateOutput: $('rateOutput'),
    hbCached: $('hbCached'),
    hbFresh: $('hbFresh'),
    hbOutput: $('hbOutput'),
    digBtn: $('digBtn'),
    digCatalogCount: $('digCatalogCount'),
    flagshipList: $('flagshipList'),
    totalFootTag: $('totalFootTag'),
    drawerBackdrop: $('drawerBackdrop'),
    explorerDrawer: $('explorerDrawer'),
    closeDrawerBtn: $('closeDrawerBtn'),
    drawerSearch: $('drawerSearch'),
    drawerList: $('drawerList'),
  };

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function formatCompact(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1_000_000) {
      const m = n / 1_000_000;
      return `${m >= 100 ? m.toFixed(1) : m.toFixed(2)}M`;
    }
    if (n >= 10_000) {
      return `${(n / 1_000).toFixed(1)}K`;
    }
    return Math.round(n).toLocaleString('en-US');
  }

  function formatMoney(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
    if (amount < 0.001) return `$${amount.toFixed(5)}`;
    if (amount < 0.01) return `$${amount.toFixed(4)}`;
    if (amount < 1000) return `$${amount.toFixed(2)}`;
    return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function formatUnitRate(perToken) {
    if (!Number.isFinite(perToken) || perToken < 0) return '';
    const perM = perToken * 1_000_000;
    if (perM === 0) return '$0/M';
    if (perM < 0.01) return `$${perM.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}/M`;
    if (perM < 1) {
      const s = perM.toFixed(3);
      return `$${s.endsWith('0') ? s.slice(0, -1) : s}/M`;
    }
    return `$${perM.toFixed(2)}/M`;
  }

  function parseTokenAmount(raw) {
    if (!raw) return null;
    const clean = String(raw).trim().replace(/,/g, '');
    const m = clean.match(/^(\d+(?:\.\d+)?)\s*(billion|million|thousand|[bmk])?$/i);
    if (!m) return null;
    const base = parseFloat(m[1]);
    if (!Number.isFinite(base)) return null;
    const unit = (m[2] || '').toLowerCase();
    let mult = 1;
    if (unit === 'b' || unit === 'billion') mult = 1_000_000_000;
    else if (unit === 'm' || unit === 'million') mult = 1_000_000;
    else if (unit === 'k' || unit === 'thousand') mult = 1_000;
    return Math.round(base * mult);
  }

  // Extract structured usage objects from pasted JSON / JSONL logs (OpenAI, OpenRouter, Anthropic, Gemini)
  function extractJsonUsage(src) {
    if (!src.includes('{') || !src.includes('}')) return null;

    const objects = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let escaped = false;

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = src.slice(start, i + 1);
          try {
            objects.push(JSON.parse(candidate));
          } catch {
            // Ignore non-JSON brace blocks
          }
          start = -1;
        }
      }
    }

    if (!objects.length) return null;

    let cached = 0;
    let fresh = 0;
    let output = 0;
    let foundAny = false;

    function visit(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach(visit);
        return;
      }

      // If this object wraps a `usage` or `usageMetadata` sub-object, walk into it directly
      if (obj.usage && typeof obj.usage === 'object') {
        visit(obj.usage);
        return;
      }
      if (obj.usageMetadata && typeof obj.usageMetadata === 'object') {
        visit(obj.usageMetadata);
        return;
      }

      // OpenAI / OpenRouter schema: prompt_tokens INCLUDES cached_tokens
      if (typeof obj.prompt_tokens === 'number' || typeof obj.completion_tokens === 'number') {
        const pt = Number(obj.prompt_tokens) || 0;
        const ct = Number(obj.completion_tokens) || 0;
        const cd =
          Number(obj.prompt_tokens_details?.cached_tokens) ||
          Number(obj.cached_tokens) ||
          Number(obj.cache_read_input_tokens) ||
          0;
        cached += cd;
        fresh += Math.max(0, pt - cd);
        output += ct;
        foundAny = true;
        return;
      }

      // Anthropic schema: input_tokens is already uncached fresh input
      if (
        typeof obj.input_tokens === 'number' ||
        typeof obj.output_tokens === 'number' ||
        typeof obj.cache_read_input_tokens === 'number'
      ) {
        const it = Number(obj.input_tokens) || 0;
        const cr = Number(obj.cache_read_input_tokens) || Number(obj.cached_tokens) || 0;
        const cw = Number(obj.cache_creation_input_tokens) || 0;
        const ot = Number(obj.output_tokens) || 0;
        const rt = Number(obj.reasoning_tokens) || 0;
        cached += cr;
        fresh += it + cw;
        output += ot + rt;
        foundAny = true;
        return;
      }

      // Gemini schema: promptTokenCount INCLUDES cachedContentTokenCount
      if (
        typeof obj.promptTokenCount === 'number' ||
        typeof obj.candidatesTokenCount === 'number'
      ) {
        const pt = Number(obj.promptTokenCount) || 0;
        const cd = Number(obj.cachedContentTokenCount) || 0;
        const ot = Number(obj.candidatesTokenCount) || 0;
        const th = Number(obj.thoughtsTokenCount) || 0;
        cached += cd;
        fresh += Math.max(0, pt - cd);
        output += ot + th;
        foundAny = true;
        return;
      }

      Object.values(obj).forEach((v) => {
        if (v && typeof v === 'object') visit(v);
      });
    }

    objects.forEach(visit);
    if (!foundAny) return null;

    return {
      cached: Math.round(cached),
      fresh: Math.round(fresh),
      output: Math.round(output),
      combinedInOut: 0,
      mode: 'exact',
      note: 'Parsed exact JSON usage payload',
    };
  }

  // Zero-guessing parser for prose summaries, tables, multi-session logs, JSON, and shorthand
  function parseUsageText(text) {
    const raw = String(text || '').trim();
    if (!raw) {
      return { cached: 0, fresh: 0, output: 0, combinedInOut: 0, mode: 'empty', note: '' };
    }

    // 1. Try exact JSON / JSONL extraction first
    const jsonRes = extractJsonUsage(raw);
    if (jsonRes) return jsonRes;

    // Normalize markdown table pipes ("| Cached input | 14.5M |" -> "Cached input: 14.5M")
    const src = raw
      .split(/\r?\n/)
      .map((line) => {
        if (/^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line)) return ''; // skip markdown table separator row
        if (line.includes('|')) {
          return line
            .replace(/^\s*\|\s*/, '')
            .replace(/\s*\|\s*$/, '')
            .replace(/\s*\|\s*/g, ': ');
        }
        return line;
      })
      .join('\n');

    // Horizontal whitespace only — never bridge across newlines!
    const HS = '[ \\t]';

    // Number token (excludes percentages like "85%" and model versions like "v4")
    const NUM = `(?<![a-zA-Z0-9._])(\\d[\\d,]*(?:\\.\\d+)?(?:${HS}*(?:billion|million|thousand|[bmk]\\b))?)(?!${HS}*%)`;

    // Short same-line conversational bridge between a number and its role, e.g. "(85%) were ", "tokens were generated "
    const BRIDGE_AFTER_NUM =
      `(?:${HS}+(?:tokens?${HS}+)?(?:\\([^)\\n]{1,32}\\)${HS}*)?(?:(?:were|was|are|is|of|in|as|for|from|came${HS}+from|read${HS}+from|reused${HS}+as|billed${HS}+as|generated|produced|written|sent|total|new|combined)\\s+){0,4})`.replace(/\\s\+/g, `${HS}+`);

    // Same-line connector between a label and a number, e.g. ": ", " = ", " was about "
    const BRIDGE_AFTER_LABEL =
      `(?:${HS}*[:=]${HS}*|${HS}+(?:were|was|are|is|of|at)${HS}+(?:(?:about|around|roughly|approx\\.?|~)${HS}+)?)`;

    // Helper: collect ALL non-overlapping matches of a pair of (afterLabel, beforeLabel) regexes and strip them
    function extractAll(inputText, afterRe, beforeRe) {
      let working = inputText;
      const values = [];

      const run = (re) => {
        working = working.replace(re, (match, numStr) => {
          const val = parseTokenAmount(numStr);
          if (val !== null) values.push(val);
          return ' ';
        });
      };

      if (afterRe) run(afterRe);
      if (beforeRe) run(beforeRe);

      return {
        sum: values.length ? values.reduce((a, b) => a + b, 0) : null,
        count: values.length,
        rest: working,
      };
    }

    let work = src;

    // 2. Detect COMBINED "input and output" / "input/output" / "in+out" / "prompt and completion" FIRST
    const combinedRole =
      `\\b(?:(?:input|prompt|in)${HS}*(?:and|&|\\/|\\+)${HS}*(?:output|completion|out)(?:${HS}+tokens?)?|(?:combined|total)${HS}+(?:input|prompt)${HS}*(?:and|&|\\/|\\+)${HS}*(?:output|completion))\\b`;
    const combinedAfter = new RegExp(`(?:"?${combinedRole}"?)${BRIDGE_AFTER_LABEL}${NUM}`, 'gi');
    const combinedBefore = new RegExp(`${NUM}${BRIDGE_AFTER_NUM}${combinedRole}`, 'gi');
    const combinedHit = extractAll(work, combinedAfter, combinedBefore);
    const combinedInOut = combinedHit.sum || 0;
    work = combinedHit.rest;

    // 3. Cached input (explicit)
    const cachedRole =
      `\\b(?:cached(?:${HS}+(?:input|context|prompt|read|tokens?))?|cache[_ -]?read(?:[_ -]?input)?(?:[_ -]?tokens?)?|read${HS}+from${HS}+cache|from${HS}+cache)\\b`;
    const cachedAfter = new RegExp(`(?:"?\\b(?:cache[_ -]?read(?:[_ -]?input)?(?:[_ -]?tokens?)?|cached[_ -]?(?:input|prompt|context|tokens?)|cached)\\b"?)${BRIDGE_AFTER_LABEL}${NUM}`, 'gi');
    const cachedBefore = new RegExp(`${NUM}${BRIDGE_AFTER_NUM}${cachedRole}`, 'gi');
    const cachedHit = extractAll(work, cachedAfter, cachedBefore);
    let cached = cachedHit.sum;
    work = cachedHit.rest;

    // 4. Cache write / creation (if explicitly listed, added to fresh input)
    const cwRole = `\\b(?:cache[_ -]?(?:write|creation)(?:[_ -]?(?:input|tokens?))?)\\b`;
    const cwAfter = new RegExp(`(?:"?${cwRole}"?)${BRIDGE_AFTER_LABEL}${NUM}`, 'gi');
    const cwBefore = new RegExp(`${NUM}${BRIDGE_AFTER_NUM}${cwRole}`, 'gi');
    const cwHit = extractAll(work, cwAfter, cwBefore);
    const cacheWrite = cwHit.sum || 0;
    work = cwHit.rest;

    // 5. Explicit fresh / uncached / non-cached / new input
    const freshRole = `\\b(?:fresh|uncached|non-cached|new)(?:${HS}+(?:input|prompt|context|tokens?))?\\b`;
    const freshAfter = new RegExp(`(?:"?\\b(?:fresh|uncached|non-cached|new)(?:[_ -]?(?:input|prompt|tokens?))?\\b"?)${BRIDGE_AFTER_LABEL}${NUM}`, 'gi');
    const freshBefore = new RegExp(`${NUM}${BRIDGE_AFTER_NUM}${freshRole}`, 'gi');
    const freshHit = extractAll(work, freshAfter, freshBefore);
    let fresh = freshHit.sum;
    work = freshHit.rest;

    // 6. Generic input / prompt (only on remaining text when explicit fresh wasn't found)
    let inputPctSplitNote = '';
    if (fresh === null) {
      const inAfter = new RegExp(`(?:"?\\b(?:input[_ -]?tokens?|prompt[_ -]?tokens?|input|prompt|in)\\b"?)${BRIDGE_AFTER_LABEL}${NUM}`, 'gi');
      const inBefore = new RegExp(`${NUM}${BRIDGE_AFTER_NUM}\\b(?:input[_ -]?tokens?|prompt[_ -]?tokens?|input|prompt|in)\\b`, 'gi');
      const inHit = extractAll(work, inAfter, inBefore);
      if (inHit.sum !== null) {
        // Check for "Input: 1.2M (90% cached)" when no explicit cached amount was found
        const pctInCached = cached === null ? src.match(/(\d+(?:\.\d+)?)\s*%\s*(?:was|were)?\s*cached\b/i) : null;
        if (pctInCached) {
          const pct = Math.min(100, Math.max(0, parseFloat(pctInCached[1])));
          cached = Math.round(inHit.sum * (pct / 100));
          fresh = Math.max(0, inHit.sum - cached);
          inputPctSplitNote = `Split input using ${pct}% cached`;
        } else {
          fresh = inHit.sum;
        }
        work = inHit.rest;
      }
    }

    if (cacheWrite > 0) {
      fresh = (fresh || 0) + cacheWrite;
    }

    // 7. Output / completion (only on remaining text — combined input+output already stripped!)
    const outRole = `\\b(?:(?:generated|produced|written)${HS}+)?(?:output[_ -]?tokens?|completion[_ -]?tokens?|output|completion|out)\\b`;
    const outAfter = new RegExp(`(?:"?\\b(?:(?:generated|produced)[_ -]+)?(?:output[_ -]?tokens?|completion[_ -]?tokens?|output|completion|out)\\b"?)${BRIDGE_AFTER_LABEL}${NUM}`, 'gi');
    const outBefore = new RegExp(`${NUM}${BRIDGE_AFTER_NUM}${outRole}`, 'gi');
    const outHit = extractAll(work, outAfter, outBefore);
    let output = outHit.sum;
    work = outHit.rest;

    // 8. Separate reasoning tokens (only if NOT phrased as "including reasoning" / "with reasoning")
    if (!/\b(?:including|incl\.?|with)\s+reasoning\b/i.test(src)) {
      const rAfter = new RegExp(`(?:"?\\b(?:reasoning[_ -]?tokens?|thinking[_ -]?tokens?|reasoning)\\b"?)${BRIDGE_AFTER_LABEL}${NUM}`, 'gi');
      const rBefore = new RegExp(`${NUM}${BRIDGE_AFTER_NUM}\\b(?:reasoning[_ -]?tokens?|thinking[_ -]?tokens?|reasoning)\\b`, 'gi');
      const rHit = extractAll(work, rAfter, rBefore);
      if (rHit.sum) {
        output = (output || 0) + rHit.sum;
      }
    }

    // Case A: Combined input + output was explicitly present (e.g. "4.13M input and output tokens")
    if (combinedInOut > 0 && fresh === null && output === null) {
      return {
        cached: cached || 0,
        fresh: combinedInOut,
        output: 0,
        combinedInOut,
        mode: 'combined',
        note: `${formatCompact(combinedInOut)} is combined input + output (not split in text)`,
      };
    }

    // Case B: Clean exact breakdown found
    if (cached !== null || fresh !== null || output !== null) {
      return {
        cached: cached || 0,
        fresh: fresh || 0,
        output: output || 0,
        combinedInOut: 0,
        mode: inputPctSplitNote ? 'estimated' : 'exact',
        note: inputPctSplitNote || 'Exact read',
      };
    }

    // Case C: Fallback — "Total 15.24M tokens, 95% were cached" (explicit total + % cached)
    const totMatch =
      src.match(new RegExp(`\\btotal${HS}*[:=\\t ]+${NUM}`, 'i')) ||
      src.match(new RegExp(`${NUM}${HS}*(?:total${HS}+)?tokens?\\b`, 'i'));
    const pctMatch = src.match(/(\d+(?:\.\d+)?)\s*%\s*(?:was|were)?\s*cached\b/i);
    const totalVal = totMatch ? parseTokenAmount(totMatch[1]) : null;

    if (totalVal !== null) {
      if (pctMatch) {
        const pct = Math.min(100, Math.max(0, parseFloat(pctMatch[1])));
        const estCached = Math.round(totalVal * (pct / 100));
        const estRem = Math.max(0, totalVal - estCached);
        return {
          cached: estCached,
          fresh: estRem,
          output: 0,
          combinedInOut: estRem,
          mode: 'combined',
          note: `${formatCompact(estRem)} uncached remaining (${pct}% cached, output not split)`,
        };
      }
      // Total tokens with NO breakdown at all -> flag honestly as unsplit!
      return {
        cached: 0,
        fresh: totalVal,
        output: 0,
        combinedInOut: totalVal,
        mode: 'combined',
        note: `${formatCompact(totalVal)} total tokens (input / output not split in text)`,
      };
    }

    // Case D: Single bare number (e.g. "2.5M")
    const bare = parseTokenAmount(src);
    if (bare !== null) {
      return {
        cached: 0,
        fresh: bare,
        output: 0,
        combinedInOut: bare,
        mode: 'combined',
        note: `${formatCompact(bare)} unlabeled tokens — split or adjust below`,
      };
    }

    // Case E: Unrecognized text -> never guess!
    return {
      cached: 0,
      fresh: 0,
      output: 0,
      combinedInOut: 0,
      mode: 'none',
      note: 'No labeled token counts found — enter Cached / Fresh / Output below',
    };
  }

  function cleanName(rawName, id) {
    return String(rawName || id).replace(/^[A-Za-z0-9\s.-]+:\s*/, '') || id;
  }

  function makeTickerCode(model) {
    if (slotMetaMap.has(model.id)) return slotMetaMap.get(model.id).code;
    const slug = (model.id.split('/')[1] || model.id).replace(/[^a-z0-9]/gi, '').toUpperCase();
    return slug.slice(0, 6) || 'MODEL';
  }

  function makeShortName(model) {
    if (slotMetaMap.has(model.id)) return slotMetaMap.get(model.id).short;
    return model.name.length > 16 ? `${model.name.slice(0, 15)}…` : model.name;
  }

  function normalizeModel(raw) {
    const p = raw.pricing || {};
    const prompt = toNum(p.prompt);
    const completion = toNum(p.completion);
    const isDynamic = (prompt !== null && prompt < 0) || (completion !== null && completion < 0);
    return {
      id: raw.id,
      name: cleanName(raw.name, raw.id),
      fullName: raw.name || raw.id,
      created: raw.created || 0,
      isDynamic,
      pricing: {
        prompt: prompt ?? 0,
        completion: completion ?? 0,
        cacheRead: toNum(p.input_cache_read),
      },
    };
  }

  function calculateModelCost(model, usage, useCache) {
    const promptRate = model.pricing.prompt;
    const completionRate = model.pricing.completion;
    const cacheRate =
      useCache && model.pricing.cacheRead !== null ? model.pricing.cacheRead : promptRate;

    const cachedCost = usage.cached * cacheRate;
    const freshCost = usage.fresh * promptRate;
    const outputCost = usage.output * completionRate;
    const total = cachedCost + freshCost + outputCost;

    const uncachedTotal = (usage.cached + usage.fresh) * promptRate + outputCost;
    const savingsPct =
      useCache && usage.cached > 0 && uncachedTotal > total && uncachedTotal > 0
        ? Math.round(((uncachedTotal - total) / uncachedTotal) * 100)
        : 0;

    return { cachedCost, freshCost, outputCost, total, uncachedTotal, savingsPct };
  }

  function resolveFamousModels() {
    slotMetaMap.clear();
    const usable = allModels.filter((m) => !m.isDynamic && !m.id.includes(':'));
    const picked = [];

    for (const slot of FAMOUS_SLOTS) {
      let chosenId = null;
      if (modelMap.has(slot.preferred) && !modelMap.get(slot.preferred).isDynamic) {
        chosenId = slot.preferred;
      } else {
        const found = usable.find((m) => slot.fallback.test(m.id) && !picked.includes(m.id));
        if (found) chosenId = found.id;
      }
      if (chosenId) {
        picked.push(chosenId);
        slotMetaMap.set(chosenId, slot);
      }
    }
    return picked;
  }

  // Render Helpers
  function syncTokenBars(skipInputSync = false) {
    const total = tokens.cached + tokens.fresh + tokens.output;
    const pctC = total > 0 ? Math.round((tokens.cached / total) * 100) : 0;
    const pctF = total > 0 ? Math.round((tokens.fresh / total) * 100) : 0;
    const pctO = total > 0 ? Math.max(0, 100 - pctC - pctF) : 0;

    const setBar = (lineEl, val) => {
      if (total <= 0 || val <= 0) {
        lineEl.style.opacity = '0';
        lineEl.setAttribute('x2', '5');
        return;
      }
      lineEl.style.opacity = '1';
      const x2 = 5 + (val / total) * 190;
      lineEl.setAttribute('x2', x2.toFixed(1));
    };

    setBar(el.barCached, tokens.cached);
    setBar(el.barFresh, tokens.fresh);
    setBar(el.barOutput, tokens.output);

    el.pctCached.textContent = `(${pctC}%)`;
    el.pctFresh.textContent = `(${pctF}%)`;
    el.pctOutput.textContent = `(${pctO}%)`;

    if (!skipInputSync) {
      el.cachedField.value = formatCompact(tokens.cached);
      el.freshField.value = formatCompact(tokens.fresh);
      el.outputField.value = formatCompact(tokens.output);
    }

    el.totalFootTag.textContent = `${formatCompact(total)} total tokens`;
    el.clearOrSampleBtn.textContent = el.usageInput.value.trim() ? 'Clear' : 'Example';
  }

  function renderCostCurve(rows) {
    if (!rows.length) {
      el.costCurveChart.innerHTML = '';
      el.curveMinLabel.textContent = '$0.00';
      el.curveMaxLabel.textContent = '$0.00';
      return;
    }

    const minCost = rows[0].calc.total;
    const maxCost = rows[rows.length - 1].calc.total;
    el.curveMinLabel.textContent = formatMoney(minCost);
    el.curveMaxLabel.textContent = formatMoney(maxCost);

    const W = 240;
    const H = 186;
    const padX = 16;
    const baseY = 172;
    const topY = 44;
    const spanY = baseY - topY;
    const n = rows.length;
    const stepX = n > 1 ? (W - padX * 2) / (n - 1) : 0;

    // Gentle power curve (pow 0.65) so budget models stay clearly visible while preserving true rank/scale
    const maxVal = Math.max(maxCost, 0.0001);
    const getPinY = (cost) => {
      if (cost <= 0) return baseY - 6;
      const norm = Math.pow(cost / maxVal, 0.65);
      return baseY - Math.max(10, norm * spanY);
    };

    let selectedPin = null;
    const pinsMarkup = rows
      .map((row, idx) => {
        const x = n > 1 ? padX + idx * stepX : W / 2;
        const y = getPinY(row.calc.total);
        const isSel = row.model.id === selectedModelId;
        if (isSel) selectedPin = { x, y, cost: formatMoney(row.calc.total) };

        return `
          <g class="pin-group ${isSel ? 'is-selected' : ''}" data-pin-id="${escapeHtml(row.model.id)}" tabindex="0" role="button" aria-label="${escapeHtml(row.model.name)}: ${formatMoney(row.calc.total)}">
            <rect class="pin-hit" x="${(x - 13).toFixed(1)}" y="${(topY - 14).toFixed(1)}" width="26" height="${(baseY - topY + 20).toFixed(1)}" />
            <line class="pin-stem" x1="${x.toFixed(1)}" y1="${baseY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" />
            <circle class="pin-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isSel ? '5.8' : '4.6'}" />
          </g>
        `;
      })
      .join('');

    let calloutMarkup = '';
    if (selectedPin) {
      const label = selectedPin.cost;
      const boxW = Math.max(46, label.length * 7.6 + 14);
      const boxH = 22;
      const boxX = Math.min(W - boxW - 2, Math.max(2, selectedPin.x - boxW / 2));
      const boxY = Math.max(4, selectedPin.y - boxH - 12);
      const tipX = selectedPin.x;
      const tipY = boxY + boxH;

      calloutMarkup = `
        <g pointer-events="none">
          <rect class="pin-callout-rect" x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH}" rx="11" />
          <polygon class="pin-callout-rect" points="${(tipX - 4).toFixed(1)},${(tipY - 1).toFixed(1)} ${(tipX + 4).toFixed(1)},${(tipY - 1).toFixed(1)} ${tipX.toFixed(1)},${(tipY + 4.5).toFixed(1)}" />
          <text class="pin-callout-text" x="${(boxX + boxW / 2).toFixed(1)}" y="${(boxY + 14.8).toFixed(1)}" text-anchor="middle">${escapeHtml(label)}</text>
        </g>
      `;
    }

    el.costCurveChart.innerHTML = `
      <svg class="curve-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax meet" role="img" aria-label="Cost comparison curve across flagship models">
        ${pinsMarkup}
        ${calloutMarkup}
      </svg>
    `;
  }

  function renderParseStatus() {
    if (!el.parseStatus) return;

    if (parseMeta.mode === 'empty' || !el.usageInput.value.trim()) {
      el.parseStatus.className = 'parse-status hidden';
      el.parseStatus.innerHTML = '';
      return;
    }

    if (parseMeta.mode === 'combined' && parseMeta.combinedInOut > 0) {
      el.parseStatus.className = 'parse-status is-warn';
      const chips = [
        { pct: 0, label: 'All in' },
        { pct: 10, label: '90/10' },
        { pct: 20, label: '80/20' },
        { pct: 30, label: '70/30' },
      ];
      el.parseStatus.innerHTML = `
        <span class="parse-msg">${escapeHtml(parseMeta.note)}</span>
        <div class="split-chips" role="group" aria-label="Split combined input and output">
          ${chips
            .map(
              (c) =>
                `<button type="button" class="split-chip ${parseMeta.splitOutPct === c.pct ? 'is-active' : ''}" data-split-out="${c.pct}">${c.label}</button>`
            )
            .join('')}
        </div>
      `;
      return;
    }

    if (parseMeta.mode === 'none') {
      el.parseStatus.className = 'parse-status is-warn';
      el.parseStatus.innerHTML = `<span class="parse-msg">${escapeHtml(parseMeta.note)}</span>`;
      return;
    }

    el.parseStatus.className = 'parse-status';
    el.parseStatus.innerHTML = `<span class="parse-msg">${escapeHtml(parseMeta.note)}</span>`;
  }

  function renderSelectedCards(selectedRow) {
    if (!selectedRow) return;
    const { model, calc } = selectedRow;

    // Vermilion Selected Model Hero + Live OpenRouter Unit Rates
    const cacheRate =
      cacheEnabled && model.pricing.cacheRead !== null ? model.pricing.cacheRead : model.pricing.prompt;
    el.selectedModelPill.textContent = model.name;
    el.heroCost.textContent = formatMoney(calc.total);
    el.hbCached.textContent = formatMoney(calc.cachedCost);
    el.hbFresh.textContent = formatMoney(calc.freshCost);
    el.hbOutput.textContent = formatMoney(calc.outputCost);
    if (el.rateCached) el.rateCached.textContent = formatUnitRate(cacheRate);
    if (el.rateFresh) el.rateFresh.textContent = formatUnitRate(model.pricing.prompt);
    if (el.rateOutput) el.rateOutput.textContent = formatUnitRate(model.pricing.completion);

    // Honest cost range when input + output were pasted combined & unsplit
    if (el.heroRangeNote) {
      if (parseMeta.mode === 'combined' && parseMeta.combinedInOut > 0 && parseMeta.splitOutPct === 0) {
        const minCalc = calculateModelCost(
          model,
          { cached: tokens.cached, fresh: parseMeta.combinedInOut, output: 0 },
          cacheEnabled
        );
        const maxCalc = calculateModelCost(
          model,
          { cached: tokens.cached, fresh: 0, output: parseMeta.combinedInOut },
          cacheEnabled
        );
        const lo = Math.min(minCalc.total, maxCalc.total);
        const hi = Math.max(minCalc.total, maxCalc.total);
        el.heroRangeNote.textContent = `range ${formatMoney(lo)} – ${formatMoney(hi)} (unsplit in/out)`;
        el.heroRangeNote.classList.remove('hidden');
      } else {
        el.heroRangeNote.textContent = '';
        el.heroRangeNote.classList.add('hidden');
      }
    }

    // Lavender Cache Savings Card
    el.stepperModelName.textContent = makeShortName(model);

    if (!cacheEnabled) {
      el.savingsBig.textContent = '0%';
      el.splitPaidFill.style.transform = 'scaleX(1)';
      el.splitPaidLabel.textContent = formatMoney(calc.total);
      el.splitUncachedLabel.textContent = 'cache off';
      el.splitLeftCap.textContent = 'full uncached rate';
      el.splitRightCap.textContent = '';
    } else if (calc.savingsPct > 0) {
      el.savingsBig.textContent = `-${calc.savingsPct}%`;
      const paidRatio = Math.min(0.68, Math.max(0.38, calc.total / Math.max(calc.uncachedTotal, 0.0001)));
      el.splitPaidFill.style.transform = `scaleX(${paidRatio.toFixed(4)})`;
      el.splitPaidLabel.textContent = formatMoney(calc.total);
      el.splitUncachedLabel.textContent = formatMoney(calc.uncachedTotal);
      el.splitLeftCap.textContent = 'paid';
      el.splitRightCap.textContent = 'uncached';
    } else {
      el.savingsBig.textContent = '0%';
      el.splitPaidFill.style.transform = 'scaleX(1)';
      el.splitPaidLabel.textContent = formatMoney(calc.total);
      el.splitUncachedLabel.textContent = formatMoney(calc.uncachedTotal);
      el.splitLeftCap.textContent = 'paid';
      el.splitRightCap.textContent = 'no cache';
    }
  }

  function renderFlagshipList(rows) {
    if (!rows.length) {
      el.flagshipList.innerHTML = `<div class="loading-black">No models available.</div>`;
      return;
    }

    el.flagshipList.innerHTML = rows
      .map((row, idx) => {
        const { model, calc, isCustom } = row;
        const isSel = model.id === selectedModelId;
        const isDimmed = !isSel && idx >= rows.length - 1;
        const code = makeTickerCode(model);
        const saveTag = cacheEnabled && calc.savingsPct > 0 ? `-${calc.savingsPct}%` : 'RAW';

        return `
          <div class="model-ticker-row ${isSel ? 'is-selected' : ''} ${isDimmed ? 'is-dimmed' : ''}" data-select-model="${escapeHtml(model.id)}" tabindex="0">
            <div class="ticker-name-wrap">
              <span class="ticker-name">${escapeHtml(model.name)}</span>
              ${isCustom ? `<button type="button" class="ticker-remove" data-unpin-id="${escapeHtml(model.id)}" aria-label="Remove ${escapeHtml(model.name)}">×</button>` : ''}
            </div>
            <div class="ticker-meta">
              <span class="ticker-code">${escapeHtml(code)}</span>
              <span class="ticker-save">${escapeHtml(saveTag)}</span>
            </div>
            <div class="ticker-price-wrap">
              ${isSel ? `<span class="active-dot" aria-hidden="true"></span>` : ''}
              <span class="ticker-price">${formatMoney(calc.total)}</span>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderAll(skipInputSync = false) {
    syncTokenBars(skipInputSync);
    renderParseStatus();
    if (allModels.length === 0) return;

    const displayedIds = [...new Set([...famousIds, ...customPinnedIds])].filter(
      (id) => modelMap.has(id) && !modelMap.get(id).isDynamic
    );

    orderedRows = displayedIds
      .map((id) => {
        const model = modelMap.get(id);
        return {
          model,
          isCustom: !famousIds.includes(id),
          calc: calculateModelCost(model, tokens, cacheEnabled),
        };
      })
      .sort((a, b) => a.calc.total - b.calc.total);

    if (!selectedModelId || !displayedIds.includes(selectedModelId)) {
      const sonnet = orderedRows.find((r) => /sonnet/i.test(r.model.id));
      selectedModelId = sonnet ? sonnet.model.id : orderedRows[Math.floor(orderedRows.length / 2)]?.model.id || null;
    }

    const selectedRow = orderedRows.find((r) => r.model.id === selectedModelId) || orderedRows[0];
    renderSelectedCards(selectedRow);
    renderCostCurve(orderedRows);
    renderFlagshipList(orderedRows);

    if (!el.explorerDrawer.classList.contains('hidden')) {
      renderDrawer();
    }
  }

  // Explorer Drawer
  function renderDrawer() {
    const q = el.drawerSearch.value.trim().toLowerCase();
    const filtered = allModels
      .filter((m) => !m.isDynamic)
      .filter((m) => !q || m.fullName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      .slice(0, 120);

    if (!filtered.length) {
      el.drawerList.innerHTML = `<div class="loading-black">No models match "${escapeHtml(q)}".</div>`;
      return;
    }

    const activeSet = new Set([...famousIds, ...customPinnedIds]);
    el.drawerList.innerHTML = filtered
      .map((m) => {
        const calc = calculateModelCost(m, tokens, cacheEnabled);
        const isFamous = famousIds.includes(m.id);
        const isPinned = activeSet.has(m.id);

        return `
          <div class="drawer-row">
            <div class="drawer-info">
              <div class="drawer-name">${escapeHtml(m.name)}</div>
              <div class="drawer-id">${escapeHtml(m.id)}</div>
            </div>
            <div class="drawer-price">${formatMoney(calc.total)}</div>
            <button
              type="button"
              class="pin-pill ${isPinned ? 'is-pinned' : ''}"
              data-toggle-pin="${escapeHtml(m.id)}"
              ${isFamous ? 'disabled' : ''}
            >${isFamous ? 'Flagship' : isPinned ? 'Pinned' : 'Pin'}</button>
          </div>
        `;
      })
      .join('');
  }

  function openDrawer() {
    el.drawerBackdrop.classList.remove('hidden');
    el.explorerDrawer.classList.remove('hidden');
    renderDrawer();
    el.drawerSearch.focus();
  }

  function closeDrawer() {
    el.drawerBackdrop.classList.add('hidden');
    el.explorerDrawer.classList.add('hidden');
  }

  // OpenRouter Live Sync
  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function applyCatalog(rawList, ts, fromCache) {
    allModels = rawList.map(normalizeModel).sort((a, b) => b.created - a.created);
    modelMap = new Map(allModels.map((m) => [m.id, m]));
    famousIds = resolveFamousModels();
    customPinnedIds = loadJson(STORAGE_KEYS.pinned, []).filter(
      (id) => modelMap.has(id) && !famousIds.includes(id)
    );

    const usableCount = allModels.filter((m) => !m.isDynamic).length;
    el.topCatalogCount.textContent = String(usableCount);
    el.digCatalogCount.textContent = String(usableCount);

    const timeStr = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.syncLabel.textContent = fromCache ? 'Live OpenRouter' : `Synced ${timeStr}`;

    renderAll();
  }

  async function fetchOpenRouter(force = false) {
    el.refreshBtn.disabled = true;

    if (!force) {
      const cached = loadJson(STORAGE_KEYS.cache, null);
      if (cached && Array.isArray(cached.data) && cached.data.length > 0) {
        applyCatalog(cached.data, cached.ts, true);
        if (Date.now() - cached.ts < 30 * 60 * 1000) {
          el.refreshBtn.disabled = false;
          return;
        }
      }
    }

    el.syncLabel.textContent = 'Syncing…';
    try {
      const res = await fetch(API_URL, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !Array.isArray(json.data)) throw new Error('Bad API payload');

      const ts = Date.now();
      try {
        localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify({ ts, data: json.data }));
      } catch {
        // Ignore quota errors
      }
      applyCatalog(json.data, ts, false);
    } catch {
      el.syncLabel.textContent = allModels.length ? 'Cached OpenRouter' : 'Offline';
      if (!allModels.length) {
        el.flagshipList.innerHTML = `<div class="loading-black">Could not reach OpenRouter API. Click Offline above to retry.</div>`;
      }
    } finally {
      el.refreshBtn.disabled = false;
    }
  }

  // Interactions
  function stepModel(delta) {
    if (!orderedRows.length) return;
    const idx = orderedRows.findIndex((r) => r.model.id === selectedModelId);
    const nextIdx = (idx + delta + orderedRows.length) % orderedRows.length;
    selectedModelId = orderedRows[nextIdx].model.id;
    renderAll(true);
  }

  function handlePaste() {
    const parsed = parseUsageText(el.usageInput.value);
    tokens = { cached: parsed.cached, fresh: parsed.fresh, output: parsed.output };
    parseMeta = {
      mode: parsed.mode,
      combinedInOut: parsed.combinedInOut || 0,
      splitOutPct: 0,
      note: parsed.note || '',
    };
    renderAll(false);
  }

  function applyTheme(theme) {
    const mode = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', mode);
    if (el.themeToggleBtn) {
      el.themeToggleBtn.classList.toggle('is-light', mode === 'light');
      el.themeToggleBtn.setAttribute('aria-checked', String(mode === 'light'));
    }
    try {
      localStorage.setItem(STORAGE_KEYS.theme, mode);
    } catch {
      // ignore
    }
  }

  function wireEvents() {
    el.refreshBtn.addEventListener('click', () => fetchOpenRouter(true));
    if (el.themeToggleBtn) {
      el.themeToggleBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        applyTheme(current === 'dark' ? 'light' : 'dark');
      });
    }
    el.openAllBtn.addEventListener('click', openDrawer);
    el.digBtn.addEventListener('click', openDrawer);
    el.closeDrawerBtn.addEventListener('click', closeDrawer);
    el.drawerBackdrop.addEventListener('click', closeDrawer);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.explorerDrawer.classList.contains('hidden')) {
        closeDrawer();
      }
    });

    el.clearOrSampleBtn.addEventListener('click', () => {
      if (el.usageInput.value.trim()) {
        el.usageInput.value = '';
        tokens = { cached: 0, fresh: 0, output: 0 };
        parseMeta = { mode: 'empty', combinedInOut: 0, splitOutPct: 0, note: '' };
        renderAll(false);
      } else {
        el.usageInput.value = SAMPLE_REPORT;
        handlePaste();
      }
      el.usageInput.focus();
    });

    // Quick split chips when pasted text has combined input + output
    if (el.parseStatus) {
      el.parseStatus.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-split-out]');
        if (!chip || parseMeta.combinedInOut <= 0) return;
        const pct = Number(chip.dataset.splitOut) || 0;
        parseMeta.splitOutPct = pct;
        const outTok = Math.round(parseMeta.combinedInOut * (pct / 100));
        tokens.output = outTok;
        tokens.fresh = Math.max(0, parseMeta.combinedInOut - outTok);
        renderAll(false);
      });
    }

    // Physical CACHE OFF / ON toggle
    el.cacheToggleBtn.addEventListener('click', () => {
      cacheEnabled = !cacheEnabled;
      el.cacheToggleBtn.classList.toggle('is-on', cacheEnabled);
      el.cacheToggleBtn.setAttribute('aria-checked', String(cacheEnabled));
      renderAll(true);
    });

    el.usageInput.addEventListener('input', handlePaste);

    // Inline editable token bar fields
    [
      ['cached', el.cachedField],
      ['fresh', el.freshField],
      ['output', el.outputField],
    ].forEach(([key, inp]) => {
      inp.addEventListener('input', () => {
        const parsed = parseTokenAmount(inp.value);
        tokens[key] = parsed !== null ? Math.max(0, parsed) : 0;
        if (parseMeta.mode !== 'empty') {
          parseMeta = { mode: 'manual', combinedInOut: 0, splitOutPct: 0, note: 'Adjusted manually' };
        }
        renderAll(true);
      });
      inp.addEventListener('blur', () => {
        inp.value = formatCompact(tokens[key]);
      });
      inp.addEventListener('focus', () => inp.select());
    });

    // Stepper arrows on Lavender card
    el.prevModelBtn.addEventListener('click', () => stepModel(-1));
    el.nextModelBtn.addEventListener('click', () => stepModel(1));

    // Clicking pins in Olive SVG Cost Curve
    el.costCurveChart.addEventListener('click', (e) => {
      const pin = e.target.closest('[data-pin-id]');
      if (!pin) return;
      selectedModelId = pin.dataset.pinId;
      renderAll(true);
    });

    el.costCurveChart.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const pin = e.target.closest('[data-pin-id]');
        if (pin) {
          e.preventDefault();
          selectedModelId = pin.dataset.pinId;
          renderAll(true);
        }
      }
    });

    // Clicking flagship rows on Pure Black
    el.flagshipList.addEventListener('click', (e) => {
      const rmBtn = e.target.closest('[data-unpin-id]');
      if (rmBtn) {
        e.stopPropagation();
        const id = rmBtn.dataset.unpinId;
        customPinnedIds = customPinnedIds.filter((x) => x !== id);
        try {
          localStorage.setItem(STORAGE_KEYS.pinned, JSON.stringify(customPinnedIds));
        } catch {
          // ignore
        }
        renderAll(true);
        return;
      }

      const row = e.target.closest('[data-select-model]');
      if (row) {
        selectedModelId = row.dataset.selectModel;
        renderAll(true);
      }
    });

    el.flagshipList.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const row = e.target.closest('[data-select-model]');
        if (row && e.target === row) {
          e.preventDefault();
          selectedModelId = row.dataset.selectModel;
          renderAll(true);
        }
      }
    });

    // Drawer search & pin
    el.drawerSearch.addEventListener('input', renderDrawer);
    el.drawerList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-toggle-pin]');
      if (!btn || btn.disabled) return;
      const id = btn.dataset.togglePin;
      if (customPinnedIds.includes(id)) {
        customPinnedIds = customPinnedIds.filter((x) => x !== id);
      } else {
        customPinnedIds.push(id);
        selectedModelId = id;
      }
      try {
        localStorage.setItem(STORAGE_KEYS.pinned, JSON.stringify(customPinnedIds));
      } catch {
        // ignore
      }
      renderAll(true);
      renderDrawer();
    });
  }

  function init() {
    let savedTheme = 'dark';
    try {
      savedTheme = localStorage.getItem(STORAGE_KEYS.theme) || 'dark';
    } catch {
      // ignore
    }
    applyTheme(savedTheme);
    el.usageInput.value = '';
    handlePaste();
    wireEvents();
    fetchOpenRouter(false);
  }

  init();
})();
