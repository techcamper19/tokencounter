(() => {
  'use strict';

  const API_URL = 'https://openrouter.ai/api/v1/models';
  const STORAGE_KEYS = {
    cache: 'ts_openrouter_models_v2',
    pinned: 'ts_custom_pinned_v2',
    theme: 'ts_theme_v2',
  };

  const SAMPLE_REPORT = `About 15.24 million tokens for the Jensen carousel + video team, according to the recorded worker sessions.

Work\tTokens
Research and script\t1.23M
Production and corrections\t4.90M
Independent review\t9.11M
Total\t15.24M
95% was cached context, meaning previously seen material reused across calls. The breakdown was:

14.50M cached input
674,508 fresh input
65,648 output, including reasoning`;

  // Famous flagship lineup (exact IDs with regex fallbacks if OpenRouter rotates slugs)
  const FAMOUS_SLOTS = [
    { preferred: 'deepseek/deepseek-v4.1-flash', fallback: /^deepseek\/deepseek-v\d.*flash$/i, shortLabel: 'DeepSeek V4.1 Flash' },
    { preferred: 'anthropic/claude-haiku-5.5', fallback: /^anthropic\/claude-haiku/i, shortLabel: 'Claude Haiku 5.5' },
    { preferred: 'google/gemini-4-hydrogen', fallback: /^google\/gemini-.*(hydrogen|flash)/i, shortLabel: 'Gemini 4 Hydrogen' },
    { preferred: 'anthropic/claude-sonnet-5.5', fallback: /^anthropic\/claude-sonnet/i, shortLabel: 'Claude Sonnet 5.5' },
    { preferred: 'openai/gpt-6.2-sol', fallback: /^openai\/gpt-\d.*sol$/i, shortLabel: 'GPT-6.2 Sol' },
    { preferred: 'google/gemini-4-neon', fallback: /^google\/gemini-.*(neon|pro)/i, shortLabel: 'Gemini 4 Neon' },
    { preferred: 'anthropic/claude-opus-5.5', fallback: /^anthropic\/claude-opus/i, shortLabel: 'Claude Opus 5.5' },
    { preferred: 'openai/gpt-6.2-astra', fallback: /^openai\/gpt-\d.*astra$/i, shortLabel: 'GPT-6.2 Astra' },
  ];

  // State
  let allModels = [];
  let modelMap = new Map();
  let famousIds = [];
  let customPinnedIds = [];
  let activeModelId = null;
  let tokens = { cached: 14500000, fresh: 674508, output: 65648 };

  const $ = (id) => document.getElementById(id);
  const el = {
    refreshBtn: $('refreshBtn'),
    syncText: $('syncText'),
    usageInput: $('usageInput'),
    loadExampleBtn: $('loadExampleBtn'),
    clearBtn: $('clearBtn'),
    cachedField: $('cachedField'),
    freshField: $('freshField'),
    outputField: $('outputField'),
    parseNote: $('parseNote'),
    totalTokensTag: $('totalTokensTag'),
    modelsList: $('modelsList'),
    catalogCount: $('catalogCount'),
    openExplorerBtn: $('openExplorerBtn'),
    drawerBackdrop: $('drawerBackdrop'),
    explorerDrawer: $('explorerDrawer'),
    closeExplorerBtn: $('closeExplorerBtn'),
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

  function formatInt(n) {
    return Math.round(n || 0).toLocaleString('en-US');
  }

  function formatCompact(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1_000_000) {
      const m = n / 1_000_000;
      return `${m >= 100 ? m.toFixed(1) : m.toFixed(2).replace(/\.?0+$/, '')}M`;
    }
    if (n >= 10_000) {
      return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    }
    return formatInt(n);
  }

  function formatMoney(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
    if (amount < 0.001) return `$${amount.toFixed(5)}`;
    if (amount < 0.01) return `$${amount.toFixed(4)}`;
    if (amount < 1000) return `$${amount.toFixed(2)}`;
    return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function formatSubMoney(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
    if (amount < 0.01) return `$${amount.toFixed(4)}`;
    return `$${amount.toFixed(2)}`;
  }

  // Parse a shorthand number like "14.50M", "674,508", "15.24 million", "65.6k", "1.2b"
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

  // Smart parser for messy session summaries, JSON usage objects, or quick shorthand
  function parseUsageText(text) {
    const src = String(text || '').trim();
    if (!src) {
      return { cached: 0, fresh: 0, output: 0, matched: false, summary: 'Empty input' };
    }

    const NUM = '(\\d[\\d,]*(?:\\.\\d+)?\\s*(?:billion|million|thousand|[bmk]\\b)?)';

    let cached = null;
    let fresh = null;
    let output = null;
    let reasoningExtra = null;
    let totalFallback = null;
    let cachedPct = null;

    // 1. Cached input (number before label OR label before number)
    const cachedBefore = new RegExp(`${NUM}\\s*(?:tokens?\\s*(?:of\\s*)?)?(?:cached(?:\\s+input|\\s+context|\\s+prompt|\\s+read|\\s+tokens?)?|cache[_\\s-]?read(?:[_\\s-]?input)?(?:[_\\s-]?tokens?)?)`, 'i');
    const cachedAfter = new RegExp(`(?:"?(?:cache[_\\s-]?read(?:[_\\s-]?input)?(?:[_\\s-]?tokens?)?|cached[_\\s-]?(?:input|prompt|context|tokens?)|cached)"?)\\s*[:=]\\s*${NUM}`, 'i');

    const mCachedAfter = src.match(cachedAfter);
    const mCachedBefore = src.match(cachedBefore);
    if (mCachedAfter) cached = parseTokenAmount(mCachedAfter[1]);
    else if (mCachedBefore) cached = parseTokenAmount(mCachedBefore[1]);

    // 2. Fresh / uncached input (explicit)
    const freshBefore = new RegExp(`${NUM}\\s*(?:fresh|uncached|non-cached|new)(?:\\s+input|\\s+prompt|\\s+tokens?)?`, 'i');
    const freshAfter = new RegExp(`(?:"?(?:fresh|uncached|non-cached|new)[_\\s-]?(?:input|prompt|tokens?)?"?)\\s*[:=]\\s*${NUM}`, 'i');

    const mFreshAfter = src.match(freshAfter);
    const mFreshBefore = src.match(freshBefore);
    if (mFreshAfter) fresh = parseTokenAmount(mFreshAfter[1]);
    else if (mFreshBefore) fresh = parseTokenAmount(mFreshBefore[1]);

    // 3. Generic input / prompt if fresh wasn't explicitly labeled (strip cached matches first so "14.50M cached input" isn't re-matched as fresh input)
    if (fresh === null) {
      const stripped = src
        .replace(new RegExp(`${NUM}\\s*(?:cached(?:\\s+input|\\s+context|\\s+prompt|\\s+read|\\s+tokens?)?|cache[_\\s-]?read(?:[_\\s-]?input)?(?:[_\\s-]?tokens?)?)`, 'gi'), ' ')
        .replace(new RegExp(`(?:"?(?:cache[_\\s-]?read(?:[_\\s-]?input)?(?:[_\\s-]?tokens?)?|cached[_\\s-]?(?:input|prompt|context|tokens?))"?)\\s*[:=]\\s*${NUM}`, 'gi'), ' ');

      const inAfter = new RegExp(`(?:"?(?:input[_\\s-]?tokens?|prompt[_\\s-]?tokens?|input|prompt|in)"?)\\s*[:=]\\s*${NUM}`, 'i');
      const inBefore = new RegExp(`${NUM}\\s*(?:input[_\\s-]?tokens?|prompt[_\\s-]?tokens?|input\\b|prompt\\b|in\\b)`, 'i');

      const mInAfter = stripped.match(inAfter);
      const mInBefore = stripped.match(inBefore);
      if (mInAfter) fresh = parseTokenAmount(mInAfter[1]);
      else if (mInBefore) fresh = parseTokenAmount(mInBefore[1]);
    }

    // 4. Output / completion
    const outAfter = new RegExp(`(?:"?(?:output[_\\s-]?tokens?|completion[_\\s-]?tokens?|output|completion|out)"?)\\s*[:=]\\s*${NUM}`, 'i');
    const outBefore = new RegExp(`${NUM}\\s*(?:output[_\\s-]?tokens?|completion[_\\s-]?tokens?|output\\b|completion\\b|out\\b)`, 'i');

    const mOutAfter = src.match(outAfter);
    const mOutBefore = src.match(outBefore);
    if (mOutAfter) output = parseTokenAmount(mOutAfter[1]);
    else if (mOutBefore) output = parseTokenAmount(mOutBefore[1]);

    // 5. Separate reasoning tokens (only if NOT phrased as "including reasoning" / "with reasoning")
    if (!/(?:including|incl\.?|with)\s+reasoning/i.test(src)) {
      const rAfter = new RegExp(`(?:"?(?:reasoning[_\\s-]?tokens?|thinking[_\\s-]?tokens?|reasoning)"?)\\s*[:=]\\s*${NUM}`, 'i');
      const rBefore = new RegExp(`${NUM}\\s*(?:reasoning[_\\s-]?tokens?|thinking[_\\s-]?tokens?|reasoning\\b)`, 'i');
      const mrA = src.match(rAfter);
      const mrB = src.match(rBefore);
      if (mrA) reasoningExtra = parseTokenAmount(mrA[1]);
      else if (mrB) reasoningExtra = parseTokenAmount(mrB[1]);
    }

    if (reasoningExtra) {
      output = (output || 0) + reasoningExtra;
    }

    // 6. Fallback: "15.24M total ... 95% cached" when explicit cached/fresh weren't found
    if (cached === null && fresh === null) {
      const totMatch =
        src.match(new RegExp(`total\\s*[:=\\t ]+${NUM}`, 'i')) ||
        src.match(new RegExp(`${NUM}\\s*(?:total\\s+)?tokens?`, 'i'));
      const pctMatch = src.match(/(\d+(?:\.\d+)?)\s*%\s*(?:was\s+)?cached/i);

      if (totMatch) totalFallback = parseTokenAmount(totMatch[1]);
      if (pctMatch) cachedPct = parseFloat(pctMatch[1]);

      if (totalFallback !== null) {
        if (cachedPct !== null && cachedPct >= 0 && cachedPct <= 100) {
          cached = Math.round(totalFallback * (cachedPct / 100));
          fresh = Math.max(0, totalFallback - cached);
        } else {
          fresh = totalFallback;
        }
      }
    }

    // 7. Single bare number fallback (e.g. "2.5M")
    if (cached === null && fresh === null && output === null) {
      const bare = parseTokenAmount(src);
      if (bare !== null) {
        fresh = bare;
      }
    }

    const matched = cached !== null || fresh !== null || output !== null;
    const result = {
      cached: cached || 0,
      fresh: fresh || 0,
      output: output || 0,
      matched,
    };

    if (!matched) {
      result.summary = 'No token counts detected yet. Try lines like "14.5M cached input, 675k fresh input, 65k output" or edit the fields above.';
    } else {
      const parts = [];
      if (result.cached > 0) parts.push(`${formatCompact(result.cached)} cached`);
      if (result.fresh > 0) parts.push(`${formatCompact(result.fresh)} fresh`);
      if (result.output > 0) parts.push(`${formatCompact(result.output)} output`);
      result.summary = `Detected ${parts.join(', ')}. Click any number above to fine-tune.`;
    }

    return result;
  }

  function cleanDisplayName(rawName, id) {
    // Strip leading "Provider: " prefix for cleaner scanning
    const stripped = String(rawName || id).replace(/^[A-Za-z0-9\s.-]+:\s*/, '');
    return stripped || id;
  }

  function normalizeModel(raw) {
    const p = raw.pricing || {};
    const prompt = toNum(p.prompt);
    const completion = toNum(p.completion);
    const isDynamic = (prompt !== null && prompt < 0) || (completion !== null && completion < 0);
    return {
      id: raw.id,
      name: cleanDisplayName(raw.name, raw.id),
      fullName: raw.name || raw.id,
      provider: (raw.id || '').split('/')[0] || 'other',
      created: raw.created || 0,
      isDynamic,
      pricing: {
        prompt: prompt ?? 0,
        completion: completion ?? 0,
        cacheRead: toNum(p.input_cache_read),
      },
    };
  }

  function calculateModelCost(model, usage) {
    const promptRate = model.pricing.prompt;
    const completionRate = model.pricing.completion;
    const cacheRate = model.pricing.cacheRead !== null ? model.pricing.cacheRead : promptRate;

    const cachedCost = usage.cached * cacheRate;
    const freshCost = usage.fresh * promptRate;
    const outputCost = usage.output * completionRate;
    const total = cachedCost + freshCost + outputCost;

    // Uncached baseline to show true cache savings
    const uncachedTotal = (usage.cached + usage.fresh) * promptRate + outputCost;
    const savingsPct =
      usage.cached > 0 && uncachedTotal > total && uncachedTotal > 0
        ? Math.round(((uncachedTotal - total) / uncachedTotal) * 100)
        : 0;

    return {
      cachedCost,
      freshCost,
      outputCost,
      total,
      savingsPct,
      hasCacheDiscount: model.pricing.cacheRead !== null && model.pricing.cacheRead < promptRate,
    };
  }

  function resolveFamousModels() {
    const usable = allModels.filter((m) => !m.isDynamic && !m.id.includes(':'));
    const picked = [];

    for (const slot of FAMOUS_SLOTS) {
      if (modelMap.has(slot.preferred) && !modelMap.get(slot.preferred).isDynamic) {
        picked.push(slot.preferred);
        continue;
      }
      const match = usable.find((m) => slot.fallback.test(m.id) && !picked.includes(m.id));
      if (match) picked.push(match.id);
    }

    return picked;
  }

  // Rendering
  function syncFieldsFromState() {
    el.cachedField.value = formatInt(tokens.cached);
    el.freshField.value = formatInt(tokens.fresh);
    el.outputField.value = formatInt(tokens.output);
  }

  function renderModels() {
    const totalToks = tokens.cached + tokens.fresh + tokens.output;
    el.totalTokensTag.textContent = `${formatCompact(totalToks)} total tokens`;

    if (allModels.length === 0) return;

    const displayedIds = [...new Set([...famousIds, ...customPinnedIds])].filter(
      (id) => modelMap.has(id) && !modelMap.get(id).isDynamic
    );

    const rows = displayedIds
      .map((id) => {
        const model = modelMap.get(id);
        return {
          model,
          isCustom: !famousIds.includes(id),
          calc: calculateModelCost(model, tokens),
        };
      })
      .sort((a, b) => a.calc.total - b.calc.total);

    if (!activeModelId || !displayedIds.includes(activeModelId)) {
      // Default highlight to middle-ground flagship (Claude Sonnet if present, else median row)
      const sonnet = rows.find((r) => /sonnet/i.test(r.model.id));
      activeModelId = sonnet ? sonnet.model.id : rows[Math.floor(rows.length / 2)]?.model.id || null;
    }

    const maxCost = Math.max(...rows.map((r) => r.calc.total), 0.000001);

    el.modelsList.innerHTML = rows
      .map(({ model, isCustom, calc }) => {
        const ratio = calc.total > 0 ? Math.max(0.03, calc.total / maxCost) : 0;
        const isActive = model.id === activeModelId;

        const breakdownParts = [];
        if (tokens.cached > 0) breakdownParts.push(`<span>cached ${formatSubMoney(calc.cachedCost)}</span>`);
        if (tokens.fresh > 0) breakdownParts.push(`<span>fresh ${formatSubMoney(calc.freshCost)}</span>`);
        if (tokens.output > 0) breakdownParts.push(`<span>out ${formatSubMoney(calc.outputCost)}</span>`);
        if (breakdownParts.length === 0) {
          breakdownParts.push(
            `<span>$${(model.pricing.prompt * 1e6).toFixed(2)}/1M in</span>`,
            `<span>$${(model.pricing.completion * 1e6).toFixed(2)}/1M out</span>`
          );
        }

        const savingsHtml =
          calc.savingsPct > 0
            ? `<div class="model-savings">${calc.savingsPct}% cache savings</div>`
            : `<div class="model-savings">standard rate</div>`;

        return `
          <div class="model-row ${isActive ? 'is-active' : ''}" data-model-id="${escapeHtml(model.id)}" tabindex="0">
            <div class="model-row-main">
              <div class="model-title-line">
                <span class="model-name">${escapeHtml(model.name)}</span>
                ${isCustom ? `<button type="button" class="unpin-btn" data-unpin-id="${escapeHtml(model.id)}" title="Remove from list" aria-label="Remove ${escapeHtml(model.name)}">Remove</button>` : ''}
              </div>
              <div class="model-breakdown">${breakdownParts.join('')}</div>
              <div class="cost-bar-track" aria-hidden="true">
                <div class="cost-bar-fill" style="transform: scaleX(${ratio.toFixed(4)})"></div>
              </div>
            </div>
            <div class="model-row-right">
              <div class="model-cost">${formatMoney(calc.total)}</div>
              ${savingsHtml}
            </div>
          </div>
        `;
      })
      .join('');

    if (!el.explorerDrawer.classList.contains('hidden')) {
      renderDrawerList();
    }
  }

  function renderDrawerList() {
    const q = el.drawerSearch.value.trim().toLowerCase();
    const filtered = allModels
      .filter((m) => !m.isDynamic)
      .filter((m) => !q || m.fullName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      .slice(0, 120);

    if (filtered.length === 0) {
      el.drawerList.innerHTML = `<div class="empty-msg">No OpenRouter models match "${escapeHtml(q)}".</div>`;
      return;
    }

    const activeSet = new Set([...famousIds, ...customPinnedIds]);

    el.drawerList.innerHTML = filtered
      .map((m) => {
        const calc = calculateModelCost(m, tokens);
        const isInMain = activeSet.has(m.id);
        const isFamous = famousIds.includes(m.id);

        return `
          <div class="drawer-row">
            <div class="drawer-model-info">
              <div class="drawer-model-name">${escapeHtml(m.name)}</div>
              <div class="drawer-model-id">${escapeHtml(m.id)}</div>
            </div>
            <div class="drawer-cost">${formatMoney(calc.total)}</div>
            <button
              type="button"
              class="pin-btn ${isInMain ? 'is-pinned' : ''}"
              data-toggle-pin="${escapeHtml(m.id)}"
              ${isFamous ? 'disabled title="Included in flagship list"' : ''}
            >${isFamous ? 'Flagship' : isInMain ? 'Pinned' : 'Pin'}</button>
          </div>
        `;
      })
      .join('');
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
    allModels = rawList
      .map(normalizeModel)
      .sort((a, b) => b.created - a.created);

    modelMap = new Map(allModels.map((m) => [m.id, m]));
    famousIds = resolveFamousModels();
    customPinnedIds = loadJson(STORAGE_KEYS.pinned, []).filter(
      (id) => modelMap.has(id) && !famousIds.includes(id)
    );

    const usableCount = allModels.filter((m) => !m.isDynamic).length;
    el.catalogCount.textContent = String(usableCount);

    const timeStr = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.syncText.textContent = fromCache
      ? `OpenRouter live rates (${timeStr})`
      : `OpenRouter synced ${timeStr}`;

    renderModels();
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

    el.syncText.textContent = 'Syncing OpenRouter rates…';
    try {
      const res = await fetch(API_URL, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !Array.isArray(json.data)) throw new Error('Invalid OpenRouter response');

      const ts = Date.now();
      try {
        localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify({ ts, data: json.data }));
      } catch {
        // Ignore quota errors
      }
      applyCatalog(json.data, ts, false);
    } catch (err) {
      if (allModels.length > 0) {
        el.syncText.textContent = 'Offline (using cached rates)';
      } else {
        el.syncText.textContent = 'Could not reach OpenRouter';
        el.modelsList.innerHTML = `<div class="empty-msg">Failed to fetch OpenRouter prices (${escapeHtml(err.message)}). Click the status link above to retry.</div>`;
      }
    } finally {
      el.refreshBtn.disabled = false;
    }
  }

  // Theme switching
  function setTheme(theme) {
    const valid = ['studio', 'almanac', 'darkroom'].includes(theme) ? theme : 'studio';
    document.documentElement.setAttribute('data-theme', valid);
    try {
      localStorage.setItem(STORAGE_KEYS.theme, valid);
    } catch {
      // ignore
    }
    document.querySelectorAll('[data-set-theme]').forEach((btn) => {
      const isCurrent = btn.dataset.setTheme === valid;
      btn.classList.toggle('active', isCurrent);
      btn.setAttribute('aria-pressed', String(isCurrent));
    });
  }

  // Drawer open/close
  function openDrawer() {
    el.drawerBackdrop.classList.remove('hidden');
    el.explorerDrawer.classList.remove('hidden');
    renderDrawerList();
    el.drawerSearch.focus();
  }

  function closeDrawer() {
    el.drawerBackdrop.classList.add('hidden');
    el.explorerDrawer.classList.add('hidden');
    el.openExplorerBtn.focus();
  }

  // Event Wiring
  function handlePasteInput() {
    const parsed = parseUsageText(el.usageInput.value);
    tokens = { cached: parsed.cached, fresh: parsed.fresh, output: parsed.output };
    syncFieldsFromState();
    el.parseNote.textContent = parsed.summary;
    renderModels();
  }

  function handleFieldEdit(fieldKey, inputEl) {
    const parsed = parseTokenAmount(inputEl.value);
    tokens[fieldKey] = parsed !== null ? Math.max(0, parsed) : 0;
    el.parseNote.textContent = 'Adjusted manually. Paste new text anytime to re-detect.';
    renderModels();
  }

  function wireEvents() {
    el.refreshBtn.addEventListener('click', () => fetchOpenRouter(true));

    el.usageInput.addEventListener('input', handlePasteInput);

    el.loadExampleBtn.addEventListener('click', () => {
      el.usageInput.value = SAMPLE_REPORT;
      handlePasteInput();
      el.usageInput.focus();
    });

    el.clearBtn.addEventListener('click', () => {
      el.usageInput.value = '';
      tokens = { cached: 0, fresh: 0, output: 0 };
      syncFieldsFromState();
      el.parseNote.textContent = 'Cleared. Paste a usage report or enter numbers above.';
      renderModels();
      el.usageInput.focus();
    });

    // Inline editable fields (live update on input, pretty-format on blur)
    [
      ['cached', el.cachedField],
      ['fresh', el.freshField],
      ['output', el.outputField],
    ].forEach(([key, input]) => {
      input.addEventListener('input', () => handleFieldEdit(key, input));
      input.addEventListener('blur', () => {
        input.value = formatInt(tokens[key]);
      });
      input.addEventListener('focus', () => input.select());
    });

    // Model row selection + custom unpin
    el.modelsList.addEventListener('click', (e) => {
      const unpinBtn = e.target.closest('[data-unpin-id]');
      if (unpinBtn) {
        e.stopPropagation();
        const id = unpinBtn.dataset.unpinId;
        customPinnedIds = customPinnedIds.filter((x) => x !== id);
        localStorage.setItem(STORAGE_KEYS.pinned, JSON.stringify(customPinnedIds));
        renderModels();
        return;
      }

      const row = e.target.closest('.model-row');
      if (row) {
        activeModelId = row.dataset.modelId;
        renderModels();
      }
    });

    el.modelsList.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const row = e.target.closest('.model-row');
        if (row && e.target === row) {
          e.preventDefault();
          activeModelId = row.dataset.modelId;
          renderModels();
        }
      }
    });

    // Explorer drawer
    el.openExplorerBtn.addEventListener('click', openDrawer);
    el.closeExplorerBtn.addEventListener('click', closeDrawer);
    el.drawerBackdrop.addEventListener('click', closeDrawer);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.explorerDrawer.classList.contains('hidden')) {
        closeDrawer();
      }
    });

    el.drawerSearch.addEventListener('input', renderDrawerList);

    el.drawerList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-toggle-pin]');
      if (!btn || btn.disabled) return;
      const id = btn.dataset.togglePin;
      if (customPinnedIds.includes(id)) {
        customPinnedIds = customPinnedIds.filter((x) => x !== id);
      } else {
        customPinnedIds.push(id);
      }
      try {
        localStorage.setItem(STORAGE_KEYS.pinned, JSON.stringify(customPinnedIds));
      } catch {
        // ignore
      }
      renderModels();
      renderDrawerList();
    });

    // Theme switcher
    document.querySelectorAll('[data-set-theme]').forEach((btn) => {
      btn.addEventListener('click', () => setTheme(btn.dataset.setTheme));
    });
  }

  function init() {
    const savedTheme = localStorage.getItem(STORAGE_KEYS.theme) || 'studio';
    setTheme(savedTheme);

    el.usageInput.value = SAMPLE_REPORT;
    handlePasteInput();
    wireEvents();
    fetchOpenRouter(false);
  }

  init();
})();
