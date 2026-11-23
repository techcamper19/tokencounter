(() => {
  'use strict';

  const API_URL = 'https://openrouter.ai/api/v1/models';
  const STORAGE_KEYS = {
    modelsCache: 'tc_openrouter_models_v1',
    spendLog: 'tc_spend_log_v1',
    pinnedCompare: 'tc_pinned_compare_v1',
    selectedModel: 'tc_selected_model_v1',
  };

  // State
  let allModels = [];
  let modelMap = new Map();
  let selectedModelId = null;
  let activeProvider = 'all';
  let searchQuery = '';
  let spendLog = [];
  let pinnedIds = [];

  // DOM elements
  const $ = (id) => document.getElementById(id);
  const el = {
    syncStatus: $('syncStatus'),
    refreshBtn: $('refreshBtn'),
    modelCountBadge: $('modelCountBadge'),
    modelSearch: $('modelSearch'),
    clearSearchBtn: $('clearSearchBtn'),
    providerChips: $('providerChips'),
    modelList: $('modelList'),
    selectedModelCard: $('selectedModelCard'),
    selectedName: $('selectedName'),
    selectedId: $('selectedId'),
    selectedRates: $('selectedRates'),
    pinCompareBtn: $('pinCompareBtn'),
    tokenModePanel: $('tokenModePanel'),
    textModePanel: $('textModePanel'),
    inputTokens: $('inputTokens'),
    outputTokens: $('outputTokens'),
    multiplier: $('multiplier'),
    cacheReadTokens: $('cacheReadTokens'),
    cacheWriteTokens: $('cacheWriteTokens'),
    reasoningTokens: $('reasoningTokens'),
    promptText: $('promptText'),
    outputText: $('outputText'),
    promptEstLabel: $('promptEstLabel'),
    outputEstLabel: $('outputEstLabel'),
    tierBadge: $('tierBadge'),
    totalCost: $('totalCost'),
    perRequestSub: $('perRequestSub'),
    breakdownBar: $('breakdownBar'),
    breakdownList: $('breakdownList'),
    entryNote: $('entryNote'),
    addLogBtn: $('addLogBtn'),
    logSummary: $('logSummary'),
    logRunningTotal: $('logRunningTotal'),
    logList: $('logList'),
    exportCsvBtn: $('exportCsvBtn'),
    clearLogBtn: $('clearLogBtn'),
    compareSubtitle: $('compareSubtitle'),
    compareBody: $('compareBody'),
    resetCompareBtn: $('resetCompareBtn'),
  };

  // Helpers
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toNum(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }

  function positiveInput(inputEl) {
    const n = Number(inputEl.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function formatInt(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  function formatCompact(n) {
    if (!n || n <= 0) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return String(n);
  }

  function formatRatePerMillion(perToken) {
    if (perToken === null || perToken === undefined) return '—';
    if (perToken < 0) return 'Dynamic';
    const perM = perToken * 1_000_000;
    if (perM === 0) return 'Free';
    if (perM < 0.01) return `$${perM.toFixed(4)}`;
    if (perM < 1) {
      const s = perM.toFixed(3);
      return `$${s.endsWith('0') ? s.slice(0, -1) : s}`;
    }
    return `$${perM.toFixed(2)}`;
  }

  function formatMoney(amount) {
    if (!Number.isFinite(amount) || amount === 0) return '$0.00';
    const abs = Math.abs(amount);
    const sign = amount < 0 ? '-' : '';
    if (abs < 0.0001) return `${sign}$${abs.toFixed(6)}`;
    if (abs < 0.01) return `${sign}$${abs.toFixed(5)}`;
    if (abs < 1) return `${sign}$${abs.toFixed(4)}`;
    if (abs < 1000) return `${sign}$${abs.toFixed(2)}`;
    return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function estimateTokensFromText(text) {
    if (!text) return 0;
    // Count CJK characters separately (~1.5 chars/token) vs Latin/code (~4 chars/token)
    const cjkMatches = text.match(/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/g);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const otherCount = text.length - cjkCount;
    return Math.max(1, Math.ceil(cjkCount / 1.5 + otherCount / 4));
  }

  function normalizeModel(raw) {
    const p = raw.pricing || {};
    const prompt = toNum(p.prompt);
    const completion = toNum(p.completion);
    const isDynamic = (prompt !== null && prompt < 0) || (completion !== null && completion < 0);
    const isFree = !isDynamic && (prompt === 0 || prompt === null) && (completion === 0 || completion === null);

    return {
      id: raw.id,
      name: raw.name || raw.id,
      provider: (raw.id || '').split('/')[0] || 'other',
      contextLength: raw.context_length || raw.top_provider?.context_length || 0,
      created: raw.created || 0,
      isDynamic,
      isFree,
      pricing: {
        prompt: prompt ?? 0,
        completion: completion ?? 0,
        cacheRead: toNum(p.input_cache_read),
        cacheWrite: toNum(p.input_cache_write),
        reasoning: toNum(p.internal_reasoning),
        overrides: Array.isArray(p.overrides) ? p.overrides : [],
      },
    };
  }

  function getEffectiveRates(model, totalPromptTokens) {
    const base = model.pricing;
    let rates = {
      prompt: base.prompt,
      completion: base.completion,
      cacheRead: base.cacheRead,
      cacheWrite: base.cacheWrite,
      reasoning: base.reasoning,
      tierApplied: null,
    };

    if (base.overrides && base.overrides.length > 0 && totalPromptTokens > 0) {
      const sorted = [...base.overrides]
        .filter((o) => Number.isFinite(Number(o.min_prompt_tokens)))
        .sort((a, b) => Number(a.min_prompt_tokens) - Number(b.min_prompt_tokens));

      for (const ovr of sorted) {
        if (totalPromptTokens >= Number(ovr.min_prompt_tokens)) {
          rates = {
            prompt: toNum(ovr.prompt) ?? rates.prompt,
            completion: toNum(ovr.completion) ?? rates.completion,
            cacheRead: toNum(ovr.input_cache_read) ?? rates.cacheRead,
            cacheWrite: toNum(ovr.input_cache_write) ?? rates.cacheWrite,
            reasoning: toNum(ovr.internal_reasoning) ?? rates.reasoning,
            tierApplied: Number(ovr.min_prompt_tokens),
          };
        }
      }
    }

    return rates;
  }

  function getCurrentUsage() {
    const input = positiveInput(el.inputTokens);
    const output = positiveInput(el.outputTokens);
    const cacheRead = positiveInput(el.cacheReadTokens);
    const cacheWrite = positiveInput(el.cacheWriteTokens);
    const reasoning = positiveInput(el.reasoningTokens);
    const multiplier = Math.max(1, Math.floor(positiveInput(el.multiplier) || 1));
    return { input, output, cacheRead, cacheWrite, reasoning, multiplier };
  }

  function calculateCost(model, usage) {
    if (!model || model.isDynamic) {
      return {
        isDynamic: true,
        perRequest: 0,
        total: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        reasoningCost: 0,
        tierApplied: null,
        rates: null,
      };
    }

    const totalPromptContext = usage.input + usage.cacheRead + usage.cacheWrite;
    const rates = getEffectiveRates(model, totalPromptContext);

    const cacheReadRate = rates.cacheRead !== null ? rates.cacheRead : rates.prompt;
    const cacheWriteRate = rates.cacheWrite !== null ? rates.cacheWrite : rates.prompt;
    const reasoningRate = rates.reasoning !== null ? rates.reasoning : rates.completion;

    const inputCost = usage.input * rates.prompt * usage.multiplier;
    const outputCost = usage.output * rates.completion * usage.multiplier;
    const cacheReadCost = usage.cacheRead * cacheReadRate * usage.multiplier;
    const cacheWriteCost = usage.cacheWrite * cacheWriteRate * usage.multiplier;
    const reasoningCost = usage.reasoning * reasoningRate * usage.multiplier;

    const total = inputCost + outputCost + cacheReadCost + cacheWriteCost + reasoningCost;
    const perRequest = total / usage.multiplier;

    return {
      isDynamic: false,
      perRequest,
      total,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheWriteCost,
      reasoningCost,
      tierApplied: rates.tierApplied,
      rates,
    };
  }

  // Pick sensible default models from live catalog for initial selection & comparison
  function pickDefaultCompareIds(models) {
    const usable = models.filter((m) => !m.isDynamic && !m.id.endsWith(':batch'));
    const wantedProviders = ['openai', 'anthropic', 'google', 'deepseek', 'x-ai', 'meta-llama', 'qwen'];
    const picked = [];

    for (const prov of wantedProviders) {
      const candidates = usable
        .filter((m) => m.provider === prov && !m.isFree)
        .sort((a, b) => b.created - a.created);
      if (candidates[0]) picked.push(candidates[0].id);
      if (candidates[1] && picked.length < 8 && (prov === 'openai' || prov === 'anthropic' || prov === 'google')) {
        // Prefer a cheaper/smaller sibling too if available
        const cheaper = candidates.find(
          (c) => c.id !== candidates[0].id && c.pricing.prompt < candidates[0].pricing.prompt
        );
        if (cheaper) picked.push(cheaper.id);
      }
    }

    if (picked.length < 5) {
      for (const m of usable) {
        if (!picked.includes(m.id)) picked.push(m.id);
        if (picked.length >= 6) break;
      }
    }
    return picked.slice(0, 8);
  }

  // Load & Sync OpenRouter Models
  function setSyncStatus(text, state = '') {
    el.syncStatus.textContent = text;
    el.syncStatus.className = `status-pill ${state}`.trim();
  }

  function applyModels(rawList, timestamp, fromCache = false) {
    allModels = rawList
      .map(normalizeModel)
      .sort((a, b) => {
        // Put non-dynamic models first, then newest first
        if (a.isDynamic !== b.isDynamic) return a.isDynamic ? 1 : -1;
        return b.created - a.created;
      });

    modelMap = new Map(allModels.map((m) => [m.id, m]));

    // Restore or pick pinned models
    const savedPinned = loadJson(STORAGE_KEYS.pinnedCompare, null);
    if (Array.isArray(savedPinned) && savedPinned.some((id) => modelMap.has(id))) {
      pinnedIds = savedPinned.filter((id) => modelMap.has(id));
    } else {
      pinnedIds = pickDefaultCompareIds(allModels);
    }

    // Restore or pick selected model
    const savedSelected = localStorage.getItem(STORAGE_KEYS.selectedModel);
    if (savedSelected && modelMap.has(savedSelected)) {
      selectedModelId = savedSelected;
    } else {
      selectedModelId = pinnedIds[0] || allModels.find((m) => !m.isDynamic)?.id || null;
    }

    const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setSyncStatus(
      `${allModels.length} models · ${fromCache ? 'cached' : 'synced'} ${timeStr}`,
      'ok'
    );

    renderModelList();
    renderSelectedModel();
    recalculate();
  }

  async function fetchModels(force = false) {
    el.refreshBtn.disabled = true;

    if (!force) {
      const cached = loadJson(STORAGE_KEYS.modelsCache, null);
      if (cached && Array.isArray(cached.data) && cached.data.length > 0) {
        applyModels(cached.data, cached.ts, true);
        // If cache is fresher than 30 min, skip network unless forced
        if (Date.now() - cached.ts < 30 * 60 * 1000) {
          el.refreshBtn.disabled = false;
          return;
        }
      }
    }

    setSyncStatus('Fetching OpenRouter pricing…');
    try {
      const res = await fetch(API_URL, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !Array.isArray(json.data)) throw new Error('Unexpected API format');

      const ts = Date.now();
      try {
        localStorage.setItem(STORAGE_KEYS.modelsCache, JSON.stringify({ ts, data: json.data }));
      } catch {
        // Ignore quota errors if storage is full
      }
      applyModels(json.data, ts, false);
    } catch (err) {
      if (allModels.length > 0) {
        setSyncStatus(`Offline (using cached ${allModels.length} models)`, 'error');
      } else {
        setSyncStatus(`Failed to load OpenRouter API: ${err.message}`, 'error');
        el.modelList.innerHTML = `<div class="empty-state">Could not reach OpenRouter API. Check your internet connection and click Refresh.</div>`;
      }
    } finally {
      el.refreshBtn.disabled = false;
    }
  }

  // Rendering: Model List
  function getFilteredModels() {
    const q = searchQuery.trim().toLowerCase();
    return allModels.filter((m) => {
      if (activeProvider === 'free') {
        if (!m.isFree) return false;
      } else if (activeProvider !== 'all') {
        if (m.provider !== activeProvider) return false;
      }

      if (!q) return true;
      return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
    });
  }

  function renderModelList() {
    const list = getFilteredModels();
    el.modelCountBadge.textContent = `${list.length} / ${allModels.length}`;

    if (list.length === 0) {
      el.modelList.innerHTML = `<div class="empty-state">No models match your filter.</div>`;
      return;
    }

    const html = list
      .map((m) => {
        const isSel = m.id === selectedModelId;
        const priceHtml = m.isDynamic
          ? `<span>Dynamic</span>`
          : m.isFree
          ? `<span class="price-free">FREE</span>`
          : `<div>${formatRatePerMillion(m.pricing.prompt)} / 1M in</div>
             <div>${formatRatePerMillion(m.pricing.completion)} / 1M out</div>`;

        return `
          <div class="model-item ${isSel ? 'selected' : ''} ${m.isDynamic ? 'dynamic' : ''}"
               data-id="${escapeHtml(m.id)}" role="option" aria-selected="${isSel}">
            <div class="model-item-main">
              <div class="model-item-name">${escapeHtml(m.name)}</div>
              <div class="model-item-id">${escapeHtml(m.id)} · ${formatCompact(m.contextLength)} ctx</div>
            </div>
            <div class="model-item-price">${priceHtml}</div>
          </div>
        `;
      })
      .join('');

    el.modelList.innerHTML = html;
  }

  function renderSelectedModel() {
    const m = modelMap.get(selectedModelId);
    if (!m) {
      el.selectedModelCard.classList.add('hidden');
      return;
    }

    el.selectedModelCard.classList.remove('hidden');
    el.selectedName.textContent = m.name;
    el.selectedId.textContent = m.id;

    const isPinned = pinnedIds.includes(m.id);
    el.pinCompareBtn.textContent = isPinned ? '★ Comparing' : '☆ Compare';
    el.pinCompareBtn.disabled = m.isDynamic;

    if (m.isDynamic) {
      el.selectedRates.innerHTML = `<span class="rate-pill">Dynamic router — pricing depends on underlying routed model</span>`;
      return;
    }

    const pills = [
      `<span class="rate-pill">In: <strong>${formatRatePerMillion(m.pricing.prompt)}</strong>/1M</span>`,
      `<span class="rate-pill">Out: <strong>${formatRatePerMillion(m.pricing.completion)}</strong>/1M</span>`,
    ];

    if (m.pricing.cacheRead !== null) {
      pills.push(`<span class="rate-pill">Cache Read: <strong>${formatRatePerMillion(m.pricing.cacheRead)}</strong>/1M</span>`);
    }
    if (m.pricing.cacheWrite !== null) {
      pills.push(`<span class="rate-pill">Cache Write: <strong>${formatRatePerMillion(m.pricing.cacheWrite)}</strong>/1M</span>`);
    }
    if (m.contextLength > 0) {
      pills.push(`<span class="rate-pill">Ctx: <strong>${formatCompact(m.contextLength)}</strong></span>`);
    }

    el.selectedRates.innerHTML = pills.join('');
  }

  // Rendering: Calculation & Breakdown
  function recalculate() {
    const model = modelMap.get(selectedModelId);
    const usage = getCurrentUsage();
    const res = calculateCost(model, usage);

    if (!model) {
      el.totalCost.textContent = '$0.00';
      el.perRequestSub.textContent = 'Select a model to calculate spend';
      el.breakdownBar.innerHTML = '';
      el.breakdownList.innerHTML = '';
      el.tierBadge.classList.add('hidden');
      el.addLogBtn.disabled = true;
      renderComparison(usage, null);
      return;
    }

    if (res.isDynamic) {
      el.totalCost.textContent = 'Dynamic';
      el.perRequestSub.textContent = 'Auto-router models vary by routed provider — pick a specific model';
      el.breakdownBar.innerHTML = '';
      el.breakdownList.innerHTML = '';
      el.tierBadge.classList.add('hidden');
      el.addLogBtn.disabled = true;
      renderComparison(usage, null);
      return;
    }

    el.addLogBtn.disabled = false;
    el.totalCost.textContent = formatMoney(res.total);

    const totalTokensSingle = usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.reasoning;
    const totalTokensAll = totalTokensSingle * usage.multiplier;

    if (usage.multiplier > 1) {
      el.perRequestSub.textContent = `${formatMoney(res.perRequest)} / request × ${formatInt(usage.multiplier)} (${formatInt(totalTokensAll)} tokens)`;
    } else {
      el.perRequestSub.textContent = `${formatInt(totalTokensSingle)} total tokens`;
    }

    if (res.tierApplied) {
      el.tierBadge.textContent = `Long-context tier (≥${formatCompact(res.tierApplied)} prompt)`;
      el.tierBadge.classList.remove('hidden');
    } else {
      el.tierBadge.classList.add('hidden');
    }

    const parts = [
      { label: 'Input tokens', tokens: usage.input * usage.multiplier, cost: res.inputCost, color: 'var(--blue)', cls: 'seg-in' },
      { label: 'Output tokens', tokens: usage.output * usage.multiplier, cost: res.outputCost, color: 'var(--accent)', cls: 'seg-out' },
      { label: 'Cache read', tokens: usage.cacheRead * usage.multiplier, cost: res.cacheReadCost, color: 'var(--purple)', cls: 'seg-cache' },
      { label: 'Cache write', tokens: usage.cacheWrite * usage.multiplier, cost: res.cacheWriteCost, color: '#c084fc', cls: 'seg-cache' },
      { label: 'Reasoning', tokens: usage.reasoning * usage.multiplier, cost: res.reasoningCost, color: 'var(--amber)', cls: 'seg-reason' },
    ];

    const visibleParts = parts.filter((p, idx) => idx < 2 || p.tokens > 0);

    // Stacked proportion bar
    if (res.total > 0) {
      el.breakdownBar.innerHTML = visibleParts
        .filter((p) => p.cost > 0)
        .map((p) => {
          const pct = Math.max(1.5, (p.cost / res.total) * 100);
          return `<div class="bar-seg ${p.cls}" style="width:${pct}%" title="${p.label}: ${formatMoney(p.cost)}"></div>`;
        })
        .join('');
    } else {
      el.breakdownBar.innerHTML = '';
    }

    // Breakdown rows
    el.breakdownList.innerHTML = visibleParts
      .map((p) => {
        const share = res.total > 0 ? ` (${Math.round((p.cost / res.total) * 100)}%)` : '';
        return `
          <div class="breakdown-row">
            <span class="breakdown-left">
              <span class="dot" style="background:${p.color}"></span>
              <span>${p.label} · ${formatInt(p.tokens)}</span>
            </span>
            <span class="breakdown-right">${formatMoney(p.cost)}${share}</span>
          </div>
        `;
      })
      .join('');

    renderComparison(usage, res.total);
  }

  // Rendering: Comparison Table
  function renderComparison(usage, selectedTotal) {
    const ids = [...pinnedIds];
    if (selectedModelId && modelMap.has(selectedModelId) && !modelMap.get(selectedModelId).isDynamic && !ids.includes(selectedModelId)) {
      ids.unshift(selectedModelId);
    }

    el.compareSubtitle.textContent = `${formatInt(usage.input)} in · ${formatInt(usage.output)} out${usage.multiplier > 1 ? ` × ${formatInt(usage.multiplier)}` : ''}`;

    const rows = ids
      .map((id) => modelMap.get(id))
      .filter((m) => m && !m.isDynamic)
      .map((m) => ({ model: m, calc: calculateCost(m, usage) }))
      .sort((a, b) => a.calc.total - b.calc.total);

    if (rows.length === 0) {
      el.compareBody.innerHTML = `<tr><td colspan="7" class="empty-state">No models pinned for comparison.</td></tr>`;
      return;
    }

    el.compareBody.innerHTML = rows
      .map(({ model: m, calc }) => {
        const isSel = m.id === selectedModelId;
        let diffHtml = `<span class="diff-same">—</span>`;
        if (isSel) {
          diffHtml = `<span class="diff-same">Selected</span>`;
        } else if (selectedTotal !== null && selectedTotal > 0) {
          const ratio = calc.total / selectedTotal;
          if (calc.total === 0) {
            diffHtml = `<span class="diff-cheaper">Free</span>`;
          } else if (Math.abs(ratio - 1) < 0.01) {
            diffHtml = `<span class="diff-same">Same</span>`;
          } else if (ratio < 1) {
            const pct = Math.round((1 - ratio) * 100);
            diffHtml = `<span class="diff-cheaper">-${pct}%</span>`;
          } else {
            diffHtml = `<span class="diff-pricier">${ratio.toFixed(1)}×</span>`;
          }
        } else if (selectedTotal === 0 && calc.total > 0) {
          diffHtml = `<span class="diff-pricier">+${formatMoney(calc.total)}</span>`;
        }

        const isPinned = pinnedIds.includes(m.id);

        return `
          <tr class="${isSel ? 'is-selected' : ''}">
            <td>
              <button class="compare-model-btn" data-select-id="${escapeHtml(m.id)}">${escapeHtml(m.name)}</button>
              <div class="compare-model-sub">${escapeHtml(m.id)}</div>
            </td>
            <td class="num">${formatRatePerMillion(m.pricing.prompt)}</td>
            <td class="num">${formatRatePerMillion(m.pricing.completion)}</td>
            <td class="num">${formatCompact(m.contextLength)}</td>
            <td class="num"><strong>${formatMoney(calc.total)}</strong></td>
            <td class="num">${diffHtml}</td>
            <td class="num">
              ${isPinned ? `<button class="del-entry-btn" data-unpin-id="${escapeHtml(m.id)}" title="Remove from comparison">×</button>` : ''}
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // Spend Log
  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveSpendLog() {
    try {
      localStorage.setItem(STORAGE_KEYS.spendLog, JSON.stringify(spendLog));
    } catch {
      // ignore
    }
  }

  function savePinned() {
    try {
      localStorage.setItem(STORAGE_KEYS.pinnedCompare, JSON.stringify(pinnedIds));
    } catch {
      // ignore
    }
  }

  function renderSpendLog() {
    const runningTotal = spendLog.reduce((sum, e) => sum + e.cost, 0);
    const totalTokens = spendLog.reduce((sum, e) => sum + e.totalTokens, 0);

    el.logRunningTotal.textContent = formatMoney(runningTotal);
    el.logSummary.textContent = `${spendLog.length} ${spendLog.length === 1 ? 'entry' : 'entries'} · ${formatInt(totalTokens)} total tokens`;

    el.exportCsvBtn.disabled = spendLog.length === 0;
    el.clearLogBtn.disabled = spendLog.length === 0;

    if (spendLog.length === 0) {
      el.logList.innerHTML = `<div class="empty-state">No logged runs yet. Click <strong>+ Add to Spend Log</strong> to track cumulative spend.</div>`;
      return;
    }

    el.logList.innerHTML = spendLog
      .map(
        (entry) => `
        <div class="log-entry">
          <div class="log-entry-info">
            <div class="log-entry-title">${escapeHtml(entry.note || entry.modelName)}</div>
            <div class="log-entry-meta">
              ${entry.note ? `${escapeHtml(entry.modelId)} · ` : ''}${formatInt(entry.input)} in / ${formatInt(entry.output)} out${entry.multiplier > 1 ? ` ×${entry.multiplier}` : ''}
            </div>
          </div>
          <div class="log-entry-right">
            <span class="log-entry-cost">${formatMoney(entry.cost)}</span>
            <button class="del-entry-btn" data-del-id="${escapeHtml(entry.id)}" title="Delete entry">×</button>
          </div>
        </div>
      `
      )
      .join('');
  }

  function addCurrentToLog() {
    const model = modelMap.get(selectedModelId);
    if (!model || model.isDynamic) return;

    const usage = getCurrentUsage();
    const res = calculateCost(model, usage);
    const totalTokens =
      (usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.reasoning) *
      usage.multiplier;

    const entry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      modelId: model.id,
      modelName: model.name,
      note: el.entryNote.value.trim(),
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      reasoning: usage.reasoning,
      multiplier: usage.multiplier,
      totalTokens,
      cost: res.total,
    };

    spendLog.unshift(entry);
    el.entryNote.value = '';
    saveSpendLog();
    renderSpendLog();
  }

  function exportCsv() {
    if (spendLog.length === 0) return;
    const headers = [
      'Timestamp',
      'Label',
      'Model ID',
      'Input Tokens',
      'Output Tokens',
      'Cache Read',
      'Cache Write',
      'Reasoning Tokens',
      'Multiplier',
      'Total Tokens',
      'Cost USD',
    ];
    const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      headers.join(','),
      ...spendLog.map((e) =>
        [
          e.timestamp,
          e.note,
          e.modelId,
          e.input,
          e.output,
          e.cacheRead,
          e.cacheWrite,
          e.reasoning,
          e.multiplier,
          e.totalTokens,
          e.cost.toFixed(8),
        ]
          .map(csvEscape)
          .join(',')
      ),
    ];

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `token-spend-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Event Wiring
  function selectModel(id) {
    if (!modelMap.has(id)) return;
    selectedModelId = id;
    localStorage.setItem(STORAGE_KEYS.selectedModel, id);
    renderModelList();
    renderSelectedModel();
    recalculate();
  }

  function wireEvents() {
    el.refreshBtn.addEventListener('click', () => fetchModels(true));

    // Search
    el.modelSearch.addEventListener('input', () => {
      searchQuery = el.modelSearch.value;
      el.clearSearchBtn.classList.toggle('hidden', !searchQuery);
      renderModelList();
    });

    el.clearSearchBtn.addEventListener('click', () => {
      el.modelSearch.value = '';
      searchQuery = '';
      el.clearSearchBtn.classList.add('hidden');
      renderModelList();
      el.modelSearch.focus();
    });

    // Global "/" shortcut to focus search
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        el.modelSearch.focus();
        el.modelSearch.select();
      }
    });

    // Provider filter chips
    el.providerChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      activeProvider = chip.dataset.provider;
      el.providerChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderModelList();
    });

    // Select model from list
    el.modelList.addEventListener('click', (e) => {
      const item = e.target.closest('.model-item');
      if (!item) return;
      selectModel(item.dataset.id);
    });

    // Pin / unpin selected model to comparison
    el.pinCompareBtn.addEventListener('click', () => {
      if (!selectedModelId) return;
      if (pinnedIds.includes(selectedModelId)) {
        pinnedIds = pinnedIds.filter((id) => id !== selectedModelId);
      } else {
        pinnedIds.push(selectedModelId);
      }
      savePinned();
      renderSelectedModel();
      recalculate();
    });

    // Mode tabs (Tokens vs Paste Text)
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        document.querySelectorAll('.tab-btn').forEach((b) => {
          const active = b === btn;
          b.classList.toggle('active', active);
          b.setAttribute('aria-selected', String(active));
        });
        el.tokenModePanel.classList.toggle('hidden', mode !== 'tokens');
        el.textModePanel.classList.toggle('hidden', mode !== 'text');
      });
    });

    // Numeric inputs
    [
      el.inputTokens,
      el.outputTokens,
      el.multiplier,
      el.cacheReadTokens,
      el.cacheWriteTokens,
      el.reasoningTokens,
    ].forEach((inp) => inp.addEventListener('input', recalculate));

    // Quick preset buttons
    document.querySelectorAll('.quick-btns').forEach((group) => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-val]');
        if (!btn) return;
        const target = $(group.dataset.target);
        if (target) {
          target.value = btn.dataset.val;
          recalculate();
        }
      });
    });

    // Paste text estimators
    el.promptText.addEventListener('input', () => {
      const txt = el.promptText.value;
      const est = estimateTokensFromText(txt);
      el.promptEstLabel.textContent = `${formatInt(txt.length)} chars ≈ ${formatInt(est)} tokens`;
      el.inputTokens.value = est;
      recalculate();
    });

    el.outputText.addEventListener('input', () => {
      const txt = el.outputText.value;
      const est = estimateTokensFromText(txt);
      el.outputEstLabel.textContent = `${formatInt(txt.length)} chars ≈ ${formatInt(est)} tokens`;
      el.outputTokens.value = est;
      recalculate();
    });

    // Spend log actions
    el.addLogBtn.addEventListener('click', addCurrentToLog);
    el.entryNote.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addCurrentToLog();
    });

    el.logList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-del-id]');
      if (!btn) return;
      spendLog = spendLog.filter((item) => item.id !== btn.dataset.delId);
      saveSpendLog();
      renderSpendLog();
    });

    el.clearLogBtn.addEventListener('click', () => {
      spendLog = [];
      saveSpendLog();
      renderSpendLog();
    });

    el.exportCsvBtn.addEventListener('click', exportCsv);

    // Comparison table interactions
    el.compareBody.addEventListener('click', (e) => {
      const selBtn = e.target.closest('[data-select-id]');
      if (selBtn) {
        selectModel(selBtn.dataset.selectId);
        return;
      }
      const unpinBtn = e.target.closest('[data-unpin-id]');
      if (unpinBtn) {
        pinnedIds = pinnedIds.filter((id) => id !== unpinBtn.dataset.unpinId);
        savePinned();
        renderSelectedModel();
        recalculate();
      }
    });

    el.resetCompareBtn.addEventListener('click', () => {
      pinnedIds = pickDefaultCompareIds(allModels);
      savePinned();
      renderSelectedModel();
      recalculate();
    });
  }

  // Init
  function init() {
    spendLog = loadJson(STORAGE_KEYS.spendLog, []);
    renderSpendLog();
    wireEvents();
    fetchModels(false);
  }

  init();
})();
