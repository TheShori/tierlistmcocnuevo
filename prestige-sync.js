/* Public prestige data from https://mcoc.gg/json/champions.json.
 * Ascension rounding matches mcoc.gg/js/_init.js (verified 2026-11-26).
 * Reads only: this module never writes to Firebase or changes champion placement.
 */
(function (root) {
  'use strict';
  const INTERVAL = 5 * 60 * 1000;
  const CACHE_KEY = 'theshori.mcoc-prestige.v1';
  const normalize = value => String(value || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

  function validate(payload) {
    if (!payload || !Array.isArray(payload.data) || payload.data.length < 200) {
      throw new Error('Incomplete mcoc.gg champion data');
    }
    const ids = new Set();
    let sevenStars = 0;
    const data = payload.data.map(c => {
      if (!Number.isInteger(c.id) || ids.has(c.id) || typeof c.name !== 'string' || !c.name.trim()
          || !Array.isArray(c.rarity) || !c.rarity.length
          || c.rarity.some(r => !Number.isInteger(r) || r < 1 || r > 7)
          || (c.ascend !== undefined && typeof c.ascend !== 'boolean')) {
        throw new Error('Invalid mcoc.gg champion record');
      }
      ids.add(c.id);
      const isSeven = c.rarity.includes(7);
      if (isSeven) {
        sevenStars++;
        for (const key of ['pi', 'pi_74']) {
          if (!Number.isInteger(c[key]) || c[key] <= 0 || c[key] > 1000000) {
            throw new Error('Invalid seven-star prestige');
          }
        }
      }
      return {id: c.id, name: c.name, rarity: c.rarity, ascend: c.ascend === true,
        pi: isSeven ? c.pi : 0, pi_74: isSeven ? c.pi_74 : 0};
    });
    if (sevenStars < 150) throw new Error('Incomplete seven-star data');
    return data;
  }

  function prestige(c) {
    const ascend = (value, factor) => Math.round(value * factor / 10) * 10;
    const r4_base = c.pi_74;
    const r5_base = c.pi;
    const r4_a1 = c.ascend && c.rarity.includes(7) ? ascend(r4_base, 1.0799) : 0;
    const r5_a1 = c.ascend && c.rarity.includes(7) ? ascend(r5_base, 1.0799) : 0;
    return {r4_base, r4_a1, r4_a2: r4_a1 ? ascend(r4_a1, 1.07995) : 0,
      r5_base, r5_a1, r5_a2: r5_a1 ? ascend(r5_a1, 1.07995) : 0};
  }

  function createClient(options = {}) {
    let index = new Map();
    let records = [];
    let timer;
    let pending;
    let started = false;
    const state = {updatedAt: null, fresh: false, error: null};
    const aliases = options.aliases || {};
    const fetcher = options.fetch || root.fetch.bind(root);
    const changed = () => { if (options.onChange) options.onChange({...state}); };
    const storage = () => options.storage === undefined ? root.localStorage : options.storage;

    function apply(data, updatedAt, fresh) {
      const next = new Map();
      for (const c of data) {
        const value = prestige(c);
        for (const name of [c.name, ...(aliases[c.name.toLowerCase()] || [])]) {
          const key = normalize(name);
          if (next.has(key) && next.get(key).id !== c.id) throw new Error('Ambiguous champion alias');
          next.set(key, {id: c.id, value});
        }
      }
      index = next;
      records = data;
      Object.assign(state, {updatedAt, fresh, error: null});
    }

    async function refresh() {
      if (pending) return pending;
      pending = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        try {
          // A rotating URL avoids the source's year-long HTTP cache.
          const bucket = Math.floor(Date.now() / INTERVAL);
          const response = await fetcher('https://mcoc.gg/json/champions.json?theshori=' + bucket,
            {cache: 'no-store', credentials: 'omit', signal: controller.signal});
          if (!response.ok) throw new Error('mcoc.gg HTTP ' + response.status);
          const data = validate(await response.json());
          if (records.length && data.length < records.length * 0.9) throw new Error('Unexpected loss of champions');
          const updatedAt = new Date().toISOString();
          apply(data, updatedAt, true);
          try { storage()?.setItem(CACHE_KEY, JSON.stringify({data, updatedAt})); } catch (_) { /* Storage can be disabled. */ }
        } catch (error) {
          state.fresh = false;
          state.error = error.message;
        } finally {
          clearTimeout(timeout);
        }
        changed();
        return {...state};
      })();
      try { return await pending; } finally { pending = null; }
    }

    function resume() {
      if (root.document.visibilityState !== 'hidden'
          && (!state.updatedAt || Date.now() - Date.parse(state.updatedAt) >= INTERVAL)) refresh();
    }

    function start() {
      if (started) return;
      started = true;
      try {
        const cached = JSON.parse(storage()?.getItem(CACHE_KEY) || 'null');
        if (cached && Number.isFinite(Date.parse(cached.updatedAt))) {
          apply(validate(cached), cached.updatedAt, false);
          changed();
        }
      } catch (_) { /* Ignore damaged or unavailable browser storage. */ }
      refresh();
      timer = setInterval(resume, INTERVAL);
      root.document.addEventListener('visibilitychange', resume);
    }

    function stop() {
      clearInterval(timer);
      root.document.removeEventListener('visibilitychange', resume);
      started = false;
    }

    return {start, stop, refresh, getState: () => ({...state}),
      get: name => {
        const entry = index.get(normalize(name));
        return entry ? {...entry.value} : null;
      }};
  }
  const api = {createClient, validate, prestige, normalize};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.McocPrestige = api;
})(typeof window !== 'undefined' ? window : globalThis);
