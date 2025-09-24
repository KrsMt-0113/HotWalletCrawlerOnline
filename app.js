// KrsMt Web Edition
// Pure front-end implementation of Arkham Hot Wallet Crawler

const CHAINS = [
  'bitcoin','ethereum','solana','tron','dogecoin','ton','base','arbitrum_one','sonic','optimism','mantle','avalanche','bsc','linea','polygon','blast','manta','flare'
];

const qs = (sel)=>document.querySelector(sel);
const qsa = (sel)=>Array.from(document.querySelectorAll(sel));

// removed chain icons due to external load issues

function buildProxyUrl(proxyBase, target){
  // Expect a proxy that takes target in a query param ?url=
  try{
    const base = new URL(proxyBase);
    const proxied = new URL(base.toString());
    proxied.searchParams.set('url', target);
    return proxied.toString();
  }catch{ return null; }
}

async function fetchWithProxyFirst(url, options, proxy){
  // Strategy: try direct first; on CORS/network error, if proxy present, try proxy.
  try{
    return await fetch(url, options);
  }catch(err){
    if(proxy){
      const proxied = buildProxyUrl(proxy, url);
      if(proxied){
        const opt = { ...options, headers: new Headers(options?.headers || {}) };
        // Forward API key to worker via X-API-Key if present
        const apiKey = opt.headers.get ? opt.headers.get('API-Key') : undefined;
        if(apiKey){
          opt.headers.delete && opt.headers.delete('API-Key');
          opt.headers.set('X-API-Key', apiKey);
        }
        return fetch(proxied, opt);
      }
    }
    throw err;
  }
}

const api = {
  async health(proxy, signal){
    const url = 'https://api.arkm.com/health';
    const resp = await fetchWithProxyFirst(url, {cache:'no-store', signal}, proxy);
    const raw = (await resp.text()).trim();
    if(!resp.ok){
      throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${raw}`);
    }
    const lower = raw.toLowerCase();
    if(lower !== 'ok'){
      throw new Error(raw || 'Arkham API not OK');
    }
    return true;
  },
  async checkKey(apiKey, proxy, signal){
    const url = 'https://api.arkm.com/chains';
    const resp = await fetchWithProxyFirst(url, { headers: { 'API-Key': apiKey }, signal }, proxy);
    const data = await resp.json().catch(()=>({}));
    // If response has a message field, assume invalid key
    if(data && typeof data === 'object' && 'message' in data){
      return { ok: false, message: data.message };
    }
    return { ok: true };
  },
  async searchEntities(query, apiKey, proxy, signal){
    const url = `https://api.arkm.com/intelligence/search?query=${encodeURIComponent(query)}`;
    const resp = await fetchWithProxyFirst(url, { headers: { 'API-Key': apiKey }, signal }, proxy);
    if(!resp.ok) throw new Error(`Search failed: ${resp.status}`);
    const data = await resp.json();
    return data.arkhamEntities || [];
  },
  async fetchTransfers({chain, entityId, limit, offset, apiKey, proxy, signal}){
    const url = new URL('https://api.arkhamintelligence.com/transfers');
    url.searchParams.set('base', entityId);
    url.searchParams.set('chains', chain);
    url.searchParams.set('flow', 'out');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('sortKey', 'time');
    url.searchParams.set('sortDir', 'desc');
    url.searchParams.set('usdGte', '1');
    const resp = await fetchWithProxyFirst(url.toString(), { headers: { 'API-Key': apiKey }, signal }, proxy);
    if(!resp.ok) throw new Error(`Transfers failed @${chain}: ${resp.status}`);
    return resp.json();
  }
};

// Simple concurrency controller to run async tasks with a limit
async function mapWithConcurrency(items, limit, task){
  const results = new Array(items.length);
  let nextIndex = 0;
  const running = new Set();
  async function runOne(){
    if(nextIndex >= items.length) return;
    const current = nextIndex++;
    const p = (async()=>{
      results[current] = await task(items[current], current);
    })().finally(()=>{ running.delete(p); });
    running.add(p);
    if(running.size >= limit){ await Promise.race(running); }
    return runOne();
  }
  const starters = Array(Math.min(limit, items.length)).fill(0).map(runOne);
  await Promise.all(starters);
  return results;
}

function extractHotWallet(addrInfo, target, expectedEntityName){
  const entityName = addrInfo?.arkhamEntity?.name;
  const labelName = addrInfo?.arkhamLabel?.name;
  if(entityName === expectedEntityName && labelName === 'Hot Wallet'){
    const address = addrInfo.address;
    const chain = addrInfo.chain;
    const key = `${address}@${chain}`;
    target[key] = {
      chain,
      address,
      arkm_url: `https://intel.arkm.com/explorer/address/${address}`,
      label: labelName
    };
  }
}

// chains are fixed to all by default; selector removed in UI

function setStatus(id, text){
  const el = qs(id);
  if(el) el.textContent = text;
}

function setProgress(percent){
  const el = qs('#overallProgress');
  el.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function ensureChainRows(chains){
  const logs = qs('#chainLogs');
  logs.innerHTML = '';
  chains.forEach(c => {
    const row = document.createElement('div');
    row.className = 'log-item';
    row.setAttribute('data-chain', c);
    row.innerHTML = `
      <div class="head">
        <span class="name">${c}</span>
      </div>
      <span class="value">待开始</span>
      <span class="time"></span>
    `;
    logs.appendChild(row);
  });
}

function setChainStatus(chain, message, startTime = null){
  const row = qs(`.log-item[data-chain="${chain}"]`);
  if(!row) return;
  
  const valueEl = row.querySelector('.value');
  const timeEl = row.querySelector('.time');
  
  if(valueEl) valueEl.textContent = message;
  
  if(startTime && timeEl){
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    timeEl.textContent = `${elapsed}s`;
  }
}

function renderEntities(entities){
  const list = qs('#entityList');
  list.innerHTML = '';
  entities.forEach((e, idx)=>{
    const div = document.createElement('div');
    div.className = 'entity';
    div.innerHTML = `
      <div class="name">${e.name}</div>
      <div class="meta">类型：${e.type || '-'} · ID：${e.id}</div>
      <div class="choose">
        <button class="btn btn-secondary" data-choose="${idx}">选择</button>
      </div>
    `;
    list.appendChild(div);
  });
}

function renderResults(rows){
  const tbody = qs('#resultBody');
  tbody.innerHTML = '';
  rows.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Chain">${r.chain}</td>
      <td class="addr" data-label="Address">${r.address} <button class="btn btn-secondary" data-copy="${r.address}">复制</button></td>
      <td data-label="Label">${r.label}</td>
      <td data-label="Link"><a href="${r.arkm_url}" target="_blank" rel="noopener noreferrer">查看</a></td>
    `;
    tbody.appendChild(tr);
  });
  // result summary is handled separately via updateResultSummary
}

function filterResults(rows, chainFilter){
  if(!chainFilter) return rows;
  return rows.filter(r => r.chain === chainFilter);
}

function updateChainFilter(allResults){
  const filter = qs('#chainFilter');
  const currentValue = filter.value;
  filter.innerHTML = '<option value="">全部链</option>';
  
  const counts = allResults.reduce((acc, r)=>{ acc[r.chain] = (acc[r.chain]||0)+1; return acc; }, {});
  const chains = Object.keys(counts).sort();
  chains.forEach(chain => {
    const option = document.createElement('option');
    option.value = chain;
    option.textContent = `${chain} (${counts[chain]})`;
    if(chain === currentValue) option.selected = true;
    filter.appendChild(option);
  });
  
  // Re-render with current filter
  const filtered = filterResults(allResults, currentValue);
  renderResults(filtered);
}

function appendResults(newRows, allResults){
  if(!newRows || !newRows.length) return;
  const filter = qs('#chainFilter');
  const currentFilter = filter.value;
  
  // Update filter options if new chains appear
  updateChainFilter(allResults);
  
  // Only append if current filter matches or is "all"
  if(!currentFilter || newRows.some(r => r.chain === currentFilter)){
    const tbody = qs('#resultBody');
    const frag = document.createDocumentFragment();
    const filtered = currentFilter ? newRows.filter(r => r.chain === currentFilter) : newRows;
    
    filtered.forEach(r=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="Chain">${r.chain}</td>
        <td class="addr" data-label="Address">${r.address} <button class="btn btn-secondary" data-copy="${r.address}">复制</button></td>
        <td data-label="Label">${r.label}</td>
        <td data-label="Link"><a href="${r.arkm_url}" target="_blank" rel="noopener noreferrer">查看</a></td>
      `;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }
}

function toCSV(rows){
  const header = ['chain','address','arkm_url','label'];
  const lines = [header.join(',')].concat(
    rows.map(r => [r.chain, r.address, r.arkm_url, r.label]
      .map(v => /[",\n]/.test(String(v)) ? '"'+String(v).replace(/"/g,'""')+'"' : String(v))
      .join(','))
  );
  return lines.join('\n');
}

function download(filename, text){
  const blob = new Blob([text], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function createAbortableTimeoutSignal(ms){
  const controller = new AbortController();
  const id = setTimeout(()=>controller.abort(new Error('请求超时')), ms);
  return { signal: controller.signal, cancel: ()=>clearTimeout(id), controller };
}

async function runCrawler({entity, apiKey, limit, pages, chains, proxy}){
  const allResults = [];
  const totalChains = chains.length;
  let completedChains = 0;
  const totalPages = totalChains * pages;
  let completedPages = 0;
  setProgress(0);
  setStatus('#overallStatus', '开始...');
  ensureChainRows(chains);

  function updateResultSummary(){
    setStatus('#resultStatus', `已完成 ${completedChains}/${totalChains} 链 · 总地址 ${allResults.length}`);
  }
  updateResultSummary();

  async function crawlOneChain(chain){
    const chainStartTime = Date.now();
    try{
      setChainStatus(chain, '进行中 · 第 0/' + pages + ' 页 · 已获 0', chainStartTime);
      const merged = {};
      let found = 0;
      for(let i=0;i<pages;i++){
        const offset = i * limit;
        if(i>0) await new Promise(r=>setTimeout(r, 1000));
        const { signal, cancel } = createAbortableTimeoutSignal(15000);
        try{
          const data = await api.fetchTransfers({chain, entityId: entity.id, limit, offset, apiKey, proxy, signal});
          const transfers = data.transfers || [];
          if(transfers.length === 0){
            completedPages += (pages - i);
            const overall = Math.round((completedPages/totalPages)*100);
            setProgress(overall);
            setStatus('#overallStatus', `进度 ${overall}%`);
            break;
          }
          const before = Object.keys(merged).length;
          transfers.forEach(tx => {
            if(tx.fromAddressOwner){
              extractHotWallet(tx.fromAddressOwner, merged, entity.name);
            } else {
              extractHotWallet(tx.fromAddress, merged, entity.name);
            }
          });
          found = Object.keys(merged).length;
          const deltaNew = found - before;
          if(deltaNew > 0){
            const newly = Object.values(merged).slice(-deltaNew);
            appendResults(newly, allResults);
          }
          setChainStatus(chain, `进行中 · 第 ${i+1}/${pages} 页 · 已获 ${found}`, chainStartTime);
          completedPages += 1;
          const overall = Math.round((completedPages/totalPages)*100);
          setProgress(overall);
          setStatus('#overallStatus', `进度 ${overall}%`);
        } finally {
          cancel();
        }
      }
      const list = Object.values(merged);
      allResults.push(...list);
      setChainStatus(chain, `完成 · 共 ${list.length} 个地址`, chainStartTime);
    }catch(err){
      console.error(err);
      setChainStatus(chain, `失败 · ${err.message || err}`, chainStartTime);
    }finally{
      completedChains += 1;
      updateResultSummary();
    }
  }

  // Run with limited concurrency to speed up overall crawl without overloading API
  await mapWithConcurrency(chains, 3, crawlOneChain);

  return allResults;
}

function setupTheme(){
  const root = document.documentElement;
  // default to light unless user explicitly toggled
  const saved = sessionStorage.getItem('theme') || 'light';
  if(saved === 'light') root.classList.add('light'); else root.classList.remove('light');
  qs('#themeToggle').addEventListener('click', ()=>{
    root.classList.toggle('light');
    sessionStorage.setItem('theme', root.classList.contains('light') ? 'light' : 'dark');
  });
}

function init(){
  setupTheme();

  const apiKeyInput = qs('#apiKey');
  const searchInput = qs('#searchInput');
  const limitInput = qs('#limitInput');
  const pagesInput = qs('#pagesInput');
  const proxyInput = qs('#proxyInput');
  const searchBtn = qs('#searchBtn');
  const runBtn = qs('#runBtn');
  const exportBtn = qs('#exportBtn');
  const clearBtn = qs('#clearBtn');
  const healthBadge = qs('#healthBadge');
  const searchSection = qs('#searchSection');
  const progressSection = qs('#progressSection');
  const resultSection = qs('#resultSection');

  let entities = [];
  let selectedEntity = null;
  let results = [];

  // request cancellation handles
  let healthController = null;
  let searchController = null;

  async function updateHealthBadge(){
    const apiKey = apiKeyInput.value.trim();
    const proxy = proxyInput.value.trim();
    
    // Only check health if either API key or proxy is provided
    if(!apiKey && !proxy){
      healthBadge.textContent = 'Health: 未配置';
      healthBadge.className = 'badge';
      return;
    }
    
    healthBadge.textContent = 'Health: 检测中...'; healthBadge.className = 'badge';
    try{
      if(healthController){ healthController.abort(); }
      healthController = new AbortController();
      const { signal, abort } = healthController;
      await api.health(proxy || undefined, signal);
      healthBadge.textContent = 'Health: OK';
      healthBadge.className = 'badge ok';
    }catch(e){
      healthBadge.textContent = 'Health: 异常';
      healthBadge.className = 'badge bad';
    }
  }
  let healthTimer = null;
  function scheduleHealthPolling(){
    if(healthTimer){ clearInterval(healthTimer); healthTimer = null; }
    const apiKey = apiKeyInput.value.trim();
    const proxy = proxyInput.value.trim();
    
    // Only start polling if either API key or proxy is provided
    if(apiKey || proxy){
      updateHealthBadge();
      healthTimer = setInterval(updateHealthBadge, 30000);
    } else {
      healthBadge.textContent = 'Health: 未配置';
      healthBadge.className = 'badge';
    }
  }
  apiKeyInput.addEventListener('input', scheduleHealthPolling);
  proxyInput.addEventListener('input', scheduleHealthPolling);
  scheduleHealthPolling();

  searchBtn.addEventListener('click', async ()=>{
    const apiKey = apiKeyInput.value.trim();
    const proxy = proxyInput.value.trim();
    const q = searchInput.value.trim();
    if(!apiKey){ setStatus('#searchStatus', '请输入 API Key'); return; }
    if(!q){ setStatus('#searchStatus', '请输入搜索关键词'); return; }
    setStatus('#searchStatus', '搜索中...');
    searchBtn.disabled = true; clearBtn.disabled = true; runBtn.disabled = true;
    try{
      if(searchController){ searchController.abort(); }
      searchController = new AbortController();
      entities = await api.searchEntities(q, apiKey, proxy || undefined, searchController.signal);
      searchSection.classList.remove('hidden');
      if(entities.length === 0){ setStatus('#searchStatus', '未找到实体'); renderEntities([]); runBtn.disabled = true; return; }
      setStatus('#searchStatus', `找到 ${entities.length} 个实体，请选择`);
      renderEntities(entities);
      runBtn.disabled = true;
      selectedEntity = null;
    }catch(err){
      setStatus('#searchStatus', `搜索失败：${err.message || err}`);
    }
    finally{
      searchBtn.disabled = false; clearBtn.disabled = false;
    }
  });

  // API Key check button
  qs('#apiKeyCheck').addEventListener('click', async ()=>{
    const apiKey = apiKeyInput.value.trim();
    const proxy = proxyInput.value.trim();
    const btn = qs('#apiKeyCheck');
    if(!apiKey){
      btn.classList.remove('btn-success','btn-danger');
      btn.textContent = '检查';
      return;
    }
    btn.disabled = true;
    btn.classList.remove('btn-success','btn-danger');
    btn.textContent = '检查中...';
    let success = false;
    try{
      const ctrl = new AbortController();
      const timeout = setTimeout(()=>ctrl.abort(), 15000);
      const res = await api.checkKey(apiKey, proxy || undefined, ctrl.signal);
      clearTimeout(timeout);
      if(res.ok){
        btn.textContent = '✓';
        btn.classList.add('btn-success');
        success = true;
      } else {
        btn.textContent = '重试';
        btn.classList.add('btn-danger');
      }
    }catch(e){
      btn.textContent = '重试';
      btn.classList.add('btn-danger');
    } finally {
      btn.disabled = success ? true : false;
    }
  });

  qs('#entityList').addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-choose]');
    if(!btn) return;
    const idx = Number(btn.getAttribute('data-choose'));
    selectedEntity = entities[idx];
    qsa('#entityList .entity').forEach((el,i)=>{
      el.style.borderColor = i===idx ? 'var(--primary)' : 'var(--border)';
    });
    setStatus('#searchStatus', `已选择：${selectedEntity.name}`);
    runBtn.disabled = false;
  });

  runBtn.addEventListener('click', async ()=>{
    const apiKey = apiKeyInput.value.trim();
    const proxy = proxyInput.value.trim();
    if(!apiKey){ setStatus('#overallStatus', '请输入 API Key'); return; }
    if(!selectedEntity){ setStatus('#overallStatus', '请先选择实体'); return; }
    const limit = Math.max(1, Math.min(1000, Number(limitInput.value)||500));
    const pages = Math.max(1, Math.min(10, Number(pagesInput.value)||3));
    const chains = CHAINS.slice();
    setStatus('#overallStatus', '准备中...');
    runBtn.disabled = true; exportBtn.disabled = true; searchBtn.disabled = true; clearBtn.disabled = true; setProgress(0); renderResults([]);
    progressSection.classList.remove('hidden');
    resultSection.classList.remove('hidden');
    try{
      results = await runCrawler({entity: selectedEntity, apiKey, limit, pages, chains, proxy: proxy || undefined});
      updateChainFilter(results);
      exportBtn.disabled = results.length === 0;
      setStatus('#overallStatus', '完成');
    }catch(err){
      setStatus('#overallStatus', `失败：${err.message || err}`);
    }finally{
      runBtn.disabled = false; searchBtn.disabled = false; clearBtn.disabled = false;
    }
  });

  clearBtn.addEventListener('click', ()=>{
    qs('#chainLogs').innerHTML = '';
    qs('#resultBody').innerHTML = '';
    qs('#chainFilter').innerHTML = '<option value="">全部链</option>';
    setStatus('#resultStatus','');
    setStatus('#overallStatus','已清空');
    setProgress(0);
    exportBtn.disabled = true;
    // Hide progress and result sections after clearing
    const progressSection = qs('#progressSection');
    const resultSection = qs('#resultSection');
    progressSection && progressSection.classList.add('hidden');
    resultSection && resultSection.classList.add('hidden');
  });

  // Chain filter change handler
  qs('#chainFilter').addEventListener('change', ()=>{
    const filter = qs('#chainFilter').value;
    const filtered = filterResults(results, filter);
    renderResults(filtered);
  });

  // Enter to trigger search
  [apiKeyInput, searchInput, limitInput, pagesInput, proxyInput].forEach(input => {
    input.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){
        e.preventDefault();
        searchBtn.click();
      }
    });
  });

  // Copy address via event delegation
  qs('#resultBody').addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-copy]');
    if(!btn) return;
    const text = btn.getAttribute('data-copy');
    navigator.clipboard.writeText(text).then(()=>{
      btn.textContent = '已复制';
      setTimeout(()=>{ btn.textContent = '复制'; }, 1200);
    }).catch(()=>{
      btn.textContent = '失败';
      setTimeout(()=>{ btn.textContent = '复制'; }, 1200);
    });
  });

  exportBtn.addEventListener('click', ()=>{
    if(!results.length) return;
    const name = selectedEntity ? selectedEntity.name.replace(/\s+/g,'_') : 'results';
    const csv = toCSV(results);
    download(`${name}_hot_wallets.csv`, csv);
  });
}

document.addEventListener('DOMContentLoaded', init);


