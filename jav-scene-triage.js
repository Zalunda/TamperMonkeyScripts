// ==UserScript==
// @name         JAV Scene Triage
// @namespace    zalunda.specializedbrowser
// @version      1.0
// @description  Go through sukebei and JAV listing sites without seeing a scene twice: finds each scene's description page, remembers seen scenes across sites, opens all unseen scenes, keeps a wanted list, and sends torrents to qBittorrent.
// @match        https://sukebei.nyaa.si/*
// @match        https://nyaa.si/*
// Destination sites (keep in sync with SITES below):
// @match        *://*.jvrlibrary.com/*
// @match        *://*.javdatabase.com/*
// @match        *://*.r18.dev/*
// @match        *://*.maxjav.com/*
// Listing sites where already-seen scenes can be hidden (keep in sync with LIST_SITES below):
// @match        *://*.3xplanet.net/*
// @match        *://*.jav-angel.net/*
// @match        *://*.myjavbay.com/*
// @connect      jvrlibrary.com
// @connect      javdatabase.com
// @connect      r18.dev
// @connect      maxjav.com
// @connect      *
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // USER SETTINGS (things you may want to change)
  // ------------------------------------------------------------------
  const PARALLEL = 3;        // how many scenes "Open all unchecked" looks up at once
  const DEFAULT_IGNORED = []; // code prefixes to ignore (not real scenes); editable with the "⚙" form
  const DEFAULT_OPEN_NEXT = 20; // default for "Open next N" (following page 2, 3...); change it with the "⚙" form, 0 = no button
  const RESUME_BACK_PAGES = 1; // "Open next" restarts this many pages before the last page it picked from (safety margin)
  const COOLDOWN_MS = 2 * 60 * 1000; // a lookup site that returns an error is skipped for this long
  const TIMEOUT_MS = 15000;  // per-request timeout (site lookups and qBittorrent)
  // qBittorrent address/login: and the share-ratio limit: use the "⚙" button in the box on the description page.

  // ------------------------------------------------------------------
  // CONFIG: sites in priority order. `probe(prefix, num)` returns the list of
  // candidate URLs to test (prefix is lowercase, num is as written on sukebei).
  // A candidate is accepted when it answers HTTP 200 and the page text
  // contains the code (fuzzy on leading zeros). `search: true` means the URL
  // is a search page: we parse the first result link containing the code.
  // `delay` (ms, optional): minimum time between two requests to that site.
  // ------------------------------------------------------------------
  const pad = (n, w) => String(n).padStart(w, '0');
  const SITES = [
    { name: 'jvrlibrary', delay: 1000,
      probe: (p, n) => [`https://www.jvrlibrary.com/jvr?id=${p.toUpperCase()}-${n}`] },
    { name: 'javdatabase', delay: 0,
      probe: (p, n) => uniq([`https://www.javdatabase.com/movies/${p}-${n}/`,
                             `https://www.javdatabase.com/movies/${p}-${pad(n, 5)}/`]) },
    { name: 'r18.dev', delay: 0, noVerify: true, // page is rendered by JS: status only
      probe: (p, n) => uniq([`https://r18.dev/videos/vod/movies/detail/-/id=${p}${pad(n, 5)}/`,
                             `https://r18.dev/videos/vod/movies/detail/-/id=${p}${n}/`]) },
    { name: 'maxjav', delay: 0, search: true, detail: /^\/\d+\/[^\/]+\/?$/, // only accept scene pages (not tag / category links)
      probe: (p, n) => [`https://maxjav.com/?s=${p}-${n}`] },
  ];
  // Listing / scene sites. `item` = one scene's container on listing pages, `title` = element
  // holding its title, `detail` = URL path of a single-scene page.
  //   want: single pages get "★ I want" / "✖ Close" buttons (wanted list)
  //   qb:   single pages get "➕ qBittorrent" using the magnet link found on the page
  //   alsoDestination: single pages also act as a lookup destination (sukebei torrent box)
  const LIST_SITES = [
    { domain: '3xplanet.net',  item: '.tdb_module_loop.td_module_wrap', title: '.entry-title a', want: true,
      detail: /^\/(?!(?:tag|category|author|page|genre|genres|actress|actresses|studio|series|maker|label|feed|search)(?:\/|$))[^\/]+\/?$/ },
    { domain: 'jav-angel.net', item: '.tdb_module_loop.td_module_wrap', title: '.entry-title a', want: true,
      detail: /^\/(?!(?:tag|category|author|page|genre|genres|actress|actresses|studio|series|maker|label|feed|search)(?:\/|$))[^\/]+\/?$/ },
    { domain: 'maxjav.com',    item: 'div.post[id^="post-"]',           title: 'h2.title a', want: true,
      alsoDestination: true, detail: /^\/\d+\/[^\/]+\/?$/ },
    { domain: 'myjavbay.com',  item: '.gridmag-grid-post',              title: '.gridmag-grid-post-title a', qb: true,
      detail: /^\/index\.php\/\d{4}\/\d{2}\/\d{2}\/[^\/]+\/?$/ },
  ];
  const uniq = (a) => [...new Set(a)];
  // sukebei title codes, upper or lower case ("MDVR-451", "(sivr-119)")
  const CODE_RE = /\b((?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{2,10})-(\d{2,5})\b/;
  const KEY = 'openedScenes';   // { "mdvr-451": timestamp }   = scene was found
  const LINKS = 'sceneLinks';   // { code: {torrent, magnet, view, t} }

  // Fuzzy code match: "dsvr-2015" also matches "dsvr-02015", "dsvr2015", "DSVR_002015".
  const codeRegex = (code) => {
    const [prefix, num] = code.split('-');
    return new RegExp('(?<![a-z0-9])' + prefix + '[-_ ]?0*' + String(parseInt(num, 10)) + '(?!\\d)', 'i');
  };
  const getOpened = () => GM_getValue(KEY, {});
  const markOpened = (code) => { const o = getOpened(); o[code] = Date.now(); GM_setValue(KEY, o); };
  const NF = 'notFoundScenes';  // { code: timestamp } = probed, no site had it
  const getNF = () => GM_getValue(NF, {});
  const setNF = (code, on) => { const o = getNF(); if (on) o[code] = Date.now(); else delete o[code]; GM_setValue(NF, o); };
  const saveLinks = (code, info) => {
    const l = GM_getValue(LINKS, {});
    l[code] = Object.assign({ t: Date.now() }, info);
    Object.keys(l).sort((a, b) => l[b].t - l[a].t).slice(200).forEach((k) => delete l[k]);
    GM_setValue(LINKS, l);
  };

  // Ignored prefixes: rows with these codes get no ℹ link and count as "no code".
  const IGN = 'ignoredPrefixes';
  const getIgnored = () => {
    const v = GM_getValue(IGN, null);
    return (Array.isArray(v) ? v : DEFAULT_IGNORED).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
  };
  const parsePrefixes = (text) => text.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);

  // "Open all unchecked" order: alphabetical by scene code (default) or page order.
  const SORT = 'sortAlpha';
  const getSortAlpha = () => GM_getValue(SORT, true);

  // Where the toolbar (Open all / Hide seen / Wanted / settings) sits on listing pages.
  const TBPOS = 'toolbarPos';
  const TB_POSITIONS = [['top-left', 'Top left'], ['top-right', 'Top right'],
                        ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']];
  const getToolbarPos = () => { const v = GM_getValue(TBPOS, 'top-left'); return TB_POSITIONS.some((x) => x[0] === v) ? v : 'top-left'; };

  // "Open next N" button: how many unseen scenes to collect (0 = button hidden).
  const ONEXT = 'openNextCount';
  const getOpenNext = () => {
    const v = parseInt(GM_getValue(ONEXT, DEFAULT_OPEN_NEXT), 10);
    return isFinite(v) && v > 0 ? Math.min(v, 200) : 0;
  };

  // "Open next N" memory: last page a scene was picked from, per listing ("host/path" -> page number).
  const LASTP = 'openNextLastPage';

  // Normalised key so "VRKM-01941" and "vrkm-1941" are the same scene.
  // (up to 10 digits: some sites use long ids like "AV-1399778673")
  const LCODE_RE = /\b((?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{2,10})-(\d{2,10})\b/;
  const normKey = (prefix, num) => prefix.toLowerCase() + '-' + parseInt(num, 10);

  // Wanted list (scenes to look at later), shared by every site: { url: {url, title, t} }
  const WANT = 'wantedList';
  const normUrl = (u) => String(u).trim().replace(/#.*$/, '').replace(/\/+$/, '');
  const getWanted = () => GM_getValue(WANT, {});
  const codeIn = (text) => { const m = LCODE_RE.exec(text || ''); return m ? m[1].toUpperCase() + '-' + m[2] : ''; };
  const addWanted = (url, code) => {
    const w = getWanted(); const k = normUrl(url);
    w[k] = { url: url.replace(/#.*$/, ''), code: code || (w[k] && w[k].code) || codeIn(url), t: (w[k] && w[k].t) || Date.now() };
    GM_setValue(WANT, w);
  };
  const removeWanted = (url) => { const w = getWanted(); delete w[normUrl(url)]; GM_setValue(WANT, w); };
  const isWanted = (url) => !!getWanted()[normUrl(url)];

  // Seen scenes are stored under the normalised key ("vrkm-1941"). Older versions stored the
  // code as written ("vrkm-01941"): rewrite those once so every lookup agrees.
  function migrateOpened() {
    const o = getOpened(); const out = {}; let changed = false;
    Object.keys(o).forEach((c) => {
      const m = /^(.+)-(\d+)$/.exec(c);
      const k = m ? normKey(m[1], m[2]) : c;
      if (k !== c) changed = true;
      out[k] = Math.max(out[k] || 0, o[c]);
    });
    if (changed) GM_setValue(KEY, out);
  }
  const seenCodes = () => Object.keys(getOpened()).map((c) => c.toUpperCase())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  function exportSeen() {
    const codes = seenCodes();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([codes.join('\n') + '\n'], { type: 'text/plain' }));
    a.download = 'seen-scenes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return codes.length;
  }
  // Reads every scene code found in `text` (any separators) and adds it to the seen list.
  function importSeen(text) {
    const re = new RegExp(LCODE_RE.source, 'g');
    const o = getOpened(); let added = 0, m;
    while ((m = re.exec(text))) {
      const k = normKey(m[1], m[2]);
      if (!o[k]) { o[k] = Date.now(); added++; }
    }
    GM_setValue(KEY, o);
    return added;
  }
  // Fuzzy import, meant for torrent / file name lists: accepts "MDVR-451", "mdvr_00451", "MDVR 451",
  // "mdvr00451", "[3DSVR-1997]"... Skips ignored prefixes and common release tags (x265, HEVC, 1080p…).
  const NOT_PREFIX = new Set(('hevc avc aac ac dts flac mp mpeg web webrip webdl hd fhd uhd sd hdr dvd bd bluray cd disc ' +
    'vol part pt ep episode season cam rip kbps fps mbps gb mb kb sample jpg png mkv avi wmv iso top hq xxx').split(' '));
  function importSeenFuzzy(text) {
    const re = /(?<![A-Za-z0-9])(\d?[A-Za-z]{2,8})([-_ .]?)0*(\d{2,5})(?!\d)/g;
    const ign = new Set(getIgnored());
    const o = getOpened(); let added = 0, found = 0, m;
    const seenNow = new Set();
    while ((m = re.exec(text))) {
      const [, prefix, sep, num] = m;
      if (NOT_PREFIX.has(prefix.toLowerCase()) || ign.has(prefix.toUpperCase())) continue;
      if (!sep && num.length < 3) continue; // "ab12" is too ambiguous without a separator
      const k = normKey(prefix, num);
      if (seenNow.has(k)) continue;
      seenNow.add(k); found++;
      if (!o[k]) { o[k] = Date.now(); added++; }
    }
    GM_setValue(KEY, o);
    return { found, added };
  }

  // ---------------------------- qBittorrent ----------------------------
  // Settings are stored by the userscript manager (menu: "Set qBittorrent Web UI").
  const QB = 'qbSettings'; // { url, user, pass, ratio }
  const DEFAULT_RATIO = 4; // pre-filled in the configure form
  const ratioOf = (cfg) => (cfg.ratio === '' || cfg.ratio == null || isNaN(Number(cfg.ratio)) ? null : Number(cfg.ratio));
  const qbReq = (cfg, path, data) => new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'POST', url: cfg.url.replace(/\/+$/, '') + path, timeout: TIMEOUT_MS,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 Referer: cfg.url, Origin: new URL(cfg.url).origin }, // qBittorrent CSRF check
      data: new URLSearchParams(data).toString(),
      onload: (r) => resolve({ status: r.status, text: (r.responseText || '').trim() }),
      onerror: () => resolve({ status: 0, text: 'connection error' }),
      ontimeout: () => resolve({ status: 0, text: 'timeout' }),
    });
  });
  // Logs in (if needed) and checks the API answers; used by the "Save & test" button.
  async function qbTest(cfg) {
    let r = await qbReq(cfg, '/api/v2/app/version', {});
    if (r.status === 401 || r.status === 403) {
      const l = await qbReq(cfg, '/api/v2/auth/login', { username: cfg.user, password: cfg.pass });
      if (l.text !== 'Ok.') return { ok: false, msg: 'login failed: ' + (l.text || l.status) };
      r = await qbReq(cfg, '/api/v2/app/version', {});
    }
    return r.status === 200 ? { ok: true } : { ok: false, msg: r.text || ('HTTP ' + r.status) };
  }
  function qbSetup() {
    const old = GM_getValue(QB, {});
    const url = prompt('qBittorrent Web UI address (e.g. http://192.168.1.10:8080):', old.url || 'http://localhost:8080');
    if (!url) return null;
    const user = prompt('Username (empty if authentication is disabled/bypassed):', old.user || '');
    const pass = user ? prompt('Password:', old.pass || '') : '';
    const cfg = { url: url.trim(), user: user || '', pass: pass || '', ratio: old.ratio == null ? DEFAULT_RATIO : old.ratio };
    GM_setValue(QB, cfg);
    return cfg;
  }
  // Returns { ok, msg }. Prefers the magnet link, falls back to the .torrent URL.
  async function qbAdd(info) {
    const urls = info.magnet || info.torrent;
    if (!urls) return { ok: false, msg: 'no torrent/magnet link found' };
    let cfg = GM_getValue(QB, null);
    if (!cfg || !cfg.url) cfg = qbSetup();
    if (!cfg) return { ok: false, msg: 'not configured' };
    const params = { urls };
    if (ratioOf(cfg) !== null) params.ratioLimit = ratioOf(cfg);
    let r = await qbReq(cfg, '/api/v2/torrents/add', params);
    if (r.status === 401 || r.status === 403) {
      const l = await qbReq(cfg, '/api/v2/auth/login', { username: cfg.user, password: cfg.pass });
      if (l.text !== 'Ok.') return { ok: false, msg: 'login failed: ' + (l.text || l.status) };
      r = await qbReq(cfg, '/api/v2/torrents/add', params);
    }
    return r.status === 200 && r.text !== 'Fails.' ? { ok: true, msg: 'added' }
                                                 : { ok: false, msg: r.text || ('HTTP ' + r.status) };
  }
  // Wires a button-like element to qbAdd; getInfo() returns the links lazily.
  function wireQb(el, label, getInfo, onSuccess) {
    el.addEventListener('click', async (ev) => {
      ev.preventDefault();
      el.textContent = '…';
      const r = await qbAdd(getInfo());
      el.textContent = r.ok ? '✔' : '✗';
      el.title = r.ok ? 'Added to qBittorrent' : 'qBittorrent: ' + r.msg;
      setTimeout(() => { el.textContent = label; }, 3000);
      if (r.ok && onSuccess) onSuccess();
    });
  }

  // ------------------------- shared UI helpers -------------------------
  const mk = (tag, css, text) => {
    const e = document.createElement(tag);
    // Default light text colour: the host site's CSS may otherwise paint our labels dark-on-dark.
    // (Later declarations in `css` override it, e.g. dark text inside the white input boxes.)
    e.style.cssText = 'color:#eee;' + (css || '');
    if (text) e.textContent = text;
    return e;
  };
  // All added UI lives in a shadow root so the host page's CSS (fonts, colours) can't leak in.
  const shadowUI = (hostCss) => {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;' + hostCss;
    const root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = '*{box-sizing:border-box;font-family:Arial,Helvetica,sans-serif;line-height:1.3} a,button,input{font-family:inherit}';
    root.appendChild(st);
    return { host, root };
  };
  const PANEL = 'width:330px;max-width:90vw;max-height:80vh;overflow:auto;background:#222;color:#fff;padding:8px 10px;' +
    'border-radius:6px;font:13px Arial,sans-serif;box-shadow:0 2px 8px #0008';
  const BTN = 'display:inline-block;margin:0 6px 4px 0;padding:3px 8px;color:#fff;border-radius:3px;' +
    'text-decoration:none;cursor:pointer;border:0;font:13px sans-serif;';
  const field = (label, type, value) => {
    const wrap = mk('label', 'display:block;margin:4px 0;font-size:12px', label);
    const input = mk('input', 'display:block;width:100%;box-sizing:border-box;margin-top:2px;padding:3px;' +
      'background:#fff;color:#000;border:1px solid #888;border-radius:3px;font:13px sans-serif');
    // A real type="password" makes Chrome offer to save a login (and it picks up the
    // neighbouring field as the "username"). Use a text field that masks its content instead.
    if (type === 'password') { input.type = 'text'; input.style.webkitTextSecurity = 'disc'; }
    else input.type = type;
    input.autocomplete = 'off';
    input.setAttribute('data-lpignore', 'true'); // password managers: ignore this field
    input.value = value || '';
    wrap.appendChild(input);
    return { wrap, input };
  };

  // Configuration form: general settings (ignored prefixes), then a qBittorrent
  // section with its own Test button, then Save / Cancel at the bottom.
  // Returns a <div>; calls onDone() after saving or cancelling.
  function configForm(onDone) {
    const f = GM_getValue(QB, null) || {};
    const heading = (text) => mk('div', 'font-weight:bold;margin:8px 0 2px;padding-top:6px;' +
      'border-top:1px solid #555;font-size:12px;color:#9cf', text);

    // --- General ---
    const ign = field('Ignored code prefixes, comma-separated (e.g. VRNC, ABC)', 'text', getIgnored().join(', '));

    const sortWrap = mk('label', 'display:block;margin:6px 0;font-size:12px;cursor:pointer');
    const sortBox = mk('input', 'margin-right:6px;vertical-align:middle');
    sortBox.type = 'checkbox'; sortBox.checked = getSortAlpha();
    sortWrap.append(sortBox, 'Open all unchecked in alphabetical order (otherwise page order)');

    const posWrap = mk('label', 'display:block;margin:6px 0;font-size:12px', 'Toolbar position ');
    const posSel = mk('select', 'margin-left:4px;padding:2px;background:#fff;color:#000;border:1px solid #888;border-radius:3px;font:12px sans-serif');
    TB_POSITIONS.forEach(([v, label]) => { const o = mk('option', 'color:#000', label); o.value = v; posSel.appendChild(o); });
    posSel.value = getToolbarPos();
    posWrap.appendChild(posSel);

    const nextWrap = mk('label', 'display:block;margin:6px 0;font-size:12px', 'Scenes for "Open next" (0 = no button) ');
    const nextIn = mk('input', 'width:60px;margin-left:4px;padding:2px;background:#fff;color:#000;border:1px solid #888;border-radius:3px;font:12px sans-serif');
    nextIn.type = 'number'; nextIn.min = '0'; nextIn.max = '200'; nextIn.value = String(getOpenNext());
    nextWrap.appendChild(nextIn);

    // --- Seen scenes: export / import ---
    const seenMsg = mk('span', 'font-size:12px');
    const exp = mk('button', BTN + 'background:#555', 'Export seen (A→Z)');
    exp.addEventListener('click', () => {
      seenMsg.style.color = '#6e6'; seenMsg.textContent = exportSeen() + ' codes exported';
    });
    const fileIn = mk('input', 'display:none');
    fileIn.type = 'file'; fileIn.accept = '.txt,.csv,text/plain';
    fileIn.addEventListener('change', async () => {
      const file = fileIn.files && fileIn.files[0];
      if (!file) return;
      const n = importSeen(await file.text());
      seenMsg.style.color = '#6e6'; seenMsg.textContent = n + ' new codes imported';
      fileIn.value = '';
    });
    const imp = mk('button', BTN + 'background:#555', 'Import seen…');
    imp.addEventListener('click', () => fileIn.click());
    // Fuzzy: any text / file-name list (several files allowed), codes are extracted by pattern.
    const fuzzIn = mk('input', 'display:none');
    fuzzIn.type = 'file'; fuzzIn.multiple = true;
    fuzzIn.addEventListener('change', async () => {
      let found = 0, added = 0;
      for (const file of Array.from(fuzzIn.files || [])) {
        const r = importSeenFuzzy(await file.text());
        found += r.found; added += r.added;
      }
      seenMsg.style.color = '#6e6';
      seenMsg.textContent = found + ' codes found, ' + added + ' new';
      fuzzIn.value = '';
    });
    const impFuzzy = mk('button', BTN + 'background:#555', 'Import (fuzzy)…');
    impFuzzy.title = 'Extract scene codes from any text file, e.g. a list of torrent / file names';
    impFuzzy.addEventListener('click', () => fuzzIn.click());

    // --- qBittorrent ---
    const url = field('Web UI address (e.g. http://192.168.1.10:8080)', 'text', f.url || '');
    const user = field('Username (empty if no authentication)', 'text', f.user);
    const pass = field('Password', 'password', f.pass);
    const ratio = field('Share ratio limit for added torrents (empty = no limit)', 'text',
                        f.ratio == null ? String(DEFAULT_RATIO) : f.ratio);
    const testMsg = mk('span', 'font-size:12px');
    const test = mk('button', BTN + 'background:#3582f7;margin-top:4px', 'Test connection');
    const readQb = () => ({ url: url.input.value.trim(), user: user.input.value, pass: pass.input.value,
                            ratio: ratio.input.value.trim() });
    test.addEventListener('click', async () => {
      const c = readQb();
      if (!/^https?:\/\//.test(c.url)) { testMsg.style.color = '#fc6'; testMsg.textContent = 'Address must start with http:// or https://'; return; }
      testMsg.style.color = '#ccc'; testMsg.textContent = 'Testing…';
      const r = await qbTest(c);
      testMsg.style.color = r.ok ? '#6e6' : '#fc6';
      testMsg.textContent = r.ok ? '✔ Connected' : '✗ ' + r.msg;
    });

    // --- Save / Cancel ---
    const msg = mk('div', 'font-size:12px;margin:6px 0 2px;color:#fc6');
    const save = mk('button', BTN + 'background:#2a8;margin-top:6px', 'Save');
    const cancel = mk('button', BTN + 'background:#666;margin-top:6px', 'Cancel');
    save.addEventListener('click', () => {
      const c = readQb();
      if (c.ratio !== '' && !(Number(c.ratio) >= 0)) { msg.textContent = 'Ratio must be a number (or empty)'; return; }
      if (c.url !== '' && !/^https?:\/\//.test(c.url)) { msg.textContent = 'Address must start with http:// or https://'; return; }
      GM_setValue(IGN, parsePrefixes(ign.input.value));
      GM_setValue(SORT, sortBox.checked);
      GM_setValue(TBPOS, posSel.value);
      GM_setValue(ONEXT, Math.max(0, parseInt(nextIn.value, 10) || 0));
      GM_setValue(QB, c.url === '' ? null : c); // empty address = qBittorrent not configured
      onDone();
    });
    cancel.addEventListener('click', onDone);

    const wrap = mk('div');
    wrap.append(ign.wrap, sortWrap, posWrap, nextWrap,
                heading('Seen scenes (' + seenCodes().length + ')'), exp, imp, impFuzzy, fileIn, fuzzIn, seenMsg,
                heading('qBittorrent remote access'), url.wrap, user.wrap, pass.wrap, ratio.wrap,
                test, testMsg, msg, save, cancel);
    return wrap;
  }

  // ------------------------------ wanted list UI ------------------------------
  function wantedPanel() {
    const wrap = mk('div');
    function render() {
      wrap.textContent = '';
      const list = Object.values(getWanted()).sort((a, b) => a.t - b.t);
      wrap.appendChild(mk('div', 'font-weight:bold;margin-bottom:6px', '★ Wanted (' + list.length + ')'));
      if (!list.length) wrap.appendChild(mk('div', 'font-size:12px;color:#aaa;margin-bottom:6px',
        'Empty. Use "★ I want" on a scene page, or add a link below.'));
      list.forEach((it) => {
        const row = mk('div', 'display:flex;gap:6px;align-items:center;margin:3px 0');
        const a = mk('a', 'flex:1;font-size:13px;color:#9cf;text-decoration:none;overflow-wrap:anywhere',
          it.code || codeIn(it.title) || codeIn(it.url) || it.url);
        a.href = it.url; a.target = '_blank'; a.rel = 'noopener'; a.title = it.url;
        const x = mk('button', 'padding:0 6px;font:12px Arial,sans-serif;cursor:pointer;border:1px solid #888;' +
          'border-radius:3px;background:#a44;color:#fff', '✖');
        x.title = 'Remove from the list';
        x.addEventListener('click', () => { removeWanted(it.url); render(); });
        row.append(a, x);
        wrap.appendChild(row);
      });
      if (list.length) {
        const all = mk('button', BTN + 'background:#c80;margin-top:6px', 'Open all (' + list.length + ')');
        all.title = 'Opens every link in background tabs. On each page, "I want" keeps it in the list, "Close" removes it.';
        all.addEventListener('click', () => {
          // new tabs are inserted right after this one: open in reverse to keep list order left-to-right
          list.slice().reverse().forEach((it) => GM_openInTab(it.url, { active: false, insert: true }));
        });
        wrap.appendChild(all);
      }
      wrap.appendChild(mk('div', 'border-top:1px solid #555;margin:8px 0 2px;padding-top:6px;font-size:12px;color:#9cf', 'Add a link manually'));
      const url = field('Address (https://…)', 'text', '');
      const msg = mk('div', 'font-size:12px;color:#fc6');
      const add = mk('button', BTN + 'background:#2a8;margin-top:4px', 'Add');
      add.addEventListener('click', () => {
        const u = url.input.value.trim();
        if (!/^https?:\/\//.test(u)) { msg.textContent = 'Address must start with http:// or https://'; return; }
        addWanted(u, codeIn(u));
        render();
      });
      wrap.append(url.wrap, msg, add);
    }
    render();
    return { el: wrap, render };
  }

  // --------------------- toolbar (every list page, position is a setting) ---------------------
  // Returns the buttons; callers attach behaviour to openAll / hide.
  function makeToolbar(withNext) {
    const [vert, horiz] = getToolbarPos().split('-');           // 'top'|'bottom', 'left'|'right'
    const { host, root } = shadowUI('display:block;position:fixed;' + vert + ':8px;' + horiz + ':8px;z-index:2147483647;');
    const side = horiz === 'left' ? 'flex-start' : 'flex-end';
    // bottom positions: the bar stays at the screen edge and the panels open above it
    const col = mk('div', 'display:flex;flex-direction:' + (vert === 'top' ? 'column' : 'column-reverse') +
      ';align-items:' + side + ';gap:4px');
    const bar = mk('div', 'display:flex;gap:6px;flex-wrap:wrap;justify-content:' + side);
    const TB_BTN = 'padding:5px 10px;font:bold 13px Arial,sans-serif;color:#fff;border:0;border-radius:4px;' +
      'cursor:pointer;margin:0;box-shadow:0 1px 4px #0006';
    const bb = (text, bg, title) => { const b = mk('button', TB_BTN + ';background:' + bg, text); if (title) b.title = title; return b; };
    const openAll = bb('Open all unchecked', '#2a8');
    const nextCount = getOpenNext();
    const openNext = withNext && nextCount ? bb('Open next ' + nextCount, '#2a8', 'Opens the next ' + nextCount + ' unseen scenes, following the next pages if needed') : null;
    const hide = bb('', '#3582f7');
    const wanted = bb('★ Wanted', '#c80', 'Scenes marked "I want"');
    const gear = bb('⚙', '#555', 'Settings (qBittorrent, ignored prefixes, toolbar position…)');
    bar.append(openAll, ...(openNext ? [openNext] : []), hide, wanted, gear);
    const below = mk('div', 'display:flex;flex-direction:column;align-items:' + side + ';gap:4px');
    col.append(bar, below);
    root.appendChild(col);

    let gearPanel = null, wantPanel = null, wp = null;
    const label = () => { wanted.textContent = '★ Wanted (' + Object.keys(getWanted()).length + ')'; };
    label();
    gear.addEventListener('click', () => {
      if (gearPanel) { gearPanel.remove(); gearPanel = null; return; }
      gearPanel = mk('div', PANEL);
      gearPanel.appendChild(mk('div', 'font-weight:bold;margin-bottom:6px', 'Settings'));
      gearPanel.appendChild(configForm(() => location.reload())); // reload so new settings apply
      below.appendChild(gearPanel);
    });
    wanted.addEventListener('click', () => {
      if (wantPanel) { wantPanel.remove(); wantPanel = null; wp = null; return; }
      wp = wantedPanel();
      wantPanel = mk('div', PANEL);
      wantPanel.appendChild(wp.el);
      below.appendChild(wantPanel);
    });
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(WANT, () => { label(); if (wp) wp.render(); });
    }
    document.body.appendChild(host);
    return { openAll, openNext, hide };
  }

  // ----------------- single-scene page box (top left, shadow DOM) -----------------
  // info: { magnet, torrent, view } or null.  want: show "★ I want".
  function detailBox({ code, info, want }) {
    const { host, root } = shadowUI('display:block;position:fixed;top:10px;left:10px;z-index:2147483647;');
    const box = mk('div', 'background:#222;color:#fff;padding:8px 10px;border-radius:6px;font:13px Arial,sans-serif;' +
      'box-shadow:0 2px 8px #0008;min-width:340px;max-width:90vw');
    root.appendChild(box);
    // Browsers only let a script close tabs it opened (tabs opened by the script / its links qualify).
    const closeTab = () => {
      window.close();
      setTimeout(() => { if (!window.closed) alert('The browser refused to close this tab (it was not opened by the script).'); }, 300);
    };
    // Any decision (download, interested, not interested) marks the scene as seen.
    const markSeen = () => { const m = /^(.+)-(\d+)$/.exec(code); if (m) markOpened(normKey(m[1], m[2])); };

    function render(showForm) {
      box.textContent = '';
      box.appendChild(mk('div', 'font-weight:bold;margin-bottom:6px', code));
      if (showForm) { box.appendChild(configForm(() => render(false))); return; }
      const cfg = GM_getValue(QB, null);
      const configured = !!(cfg && cfg.url);
      const BIG = 'padding:10px 14px;font-size:16px;font-weight:bold;text-align:center;color:#fff;' +
        'border-radius:4px;text-decoration:none;cursor:pointer;flex:1;white-space:nowrap;';
      const bigRow = mk('div', 'display:flex;gap:6px;margin-bottom:6px');
      if (info && configured && (info.magnet || info.torrent)) {
        // qBittorrent configured: one button sends it, no need for the raw torrent/magnet links
        const qb = mk('a', BIG + 'background:#2a8', '➕ qBittorrent');
        qb.href = '#';
        // after a successful add, close this tab (after a short pause so you see the ✔)
        wireQb(qb, '➕ qBittorrent', () => info, () => { markSeen(); setTimeout(closeTab, 800); });
        bigRow.appendChild(qb);
      } else if (info) {
        // no qBittorrent: big Torrent / Magnet buttons
        const dl = (text, url, bg) => {
          if (!url) return;
          const a = mk('a', BIG + 'background:' + bg, text);
          a.href = url;
          a.addEventListener('click', markSeen);
          bigRow.appendChild(a);
        };
        dl('⬇ Torrent', info.torrent, '#3582f7');
        dl('🧲 Magnet', info.magnet, '#3582f7');
      }
      // "I want" is only offered when there is no torrent/magnet to download (an already wanted page keeps its "Keep" button)
      const hasLink = !!(info && (info.magnet || info.torrent));
      if (want && (!hasLink || isWanted(location.href))) {
        const w = mk('a', BIG + 'background:#c80', isWanted(location.href) ? '★ Keep' : '★ I want');
        w.href = '#';
        w.addEventListener('click', (ev) => {
          ev.preventDefault();
          addWanted(location.href, code);
          markSeen();
          w.textContent = '★ Added';
          setTimeout(closeTab, 500);
        });
        bigRow.appendChild(w);
      }
      const close = mk('a', BIG + 'background:#a44', '✖ Not interested');
      close.href = '#';
      // Marks the scene as seen, removes it from the wanted list if it was there, and closes the tab.
      close.addEventListener('click', (ev) => { ev.preventDefault(); markSeen(); removeWanted(location.href); closeTab(); });
      bigRow.appendChild(close);
      box.appendChild(bigRow);

      if (info) {
        const cfgBtn = mk('a', BTN + 'background:#555;font-size:11px;padding:2px 6px', configured ? '⚙' : '⚙ Configure qBittorrent');
        cfgBtn.href = '#';
        cfgBtn.title = 'Configure qBittorrent remote access';
        cfgBtn.addEventListener('click', (ev) => { ev.preventDefault(); render(true); });
        box.appendChild(cfgBtn);
      }
    }
    render(false);
    document.body.appendChild(host);
  }

  // ---------------------- listing sites: hide seen / open all ----------------------
  function listMode(ls, items) {
    const hideKey = 'hideSeen:' + ls.domain;
    const st = document.createElement('style');
    st.textContent = '.sil-l-seen{opacity:.4} body.sil-l-hide .sil-l-seen{display:none !important}' +
      '.sil-l-badge{display:inline-block;margin-right:4px;padding:0 4px;font:11px Arial,sans-serif;color:#555;' +
      'background:#eee;border:1px solid #ccc;border-radius:3px}' +
      '.sil-l-badge.sil-l-want{color:#fff;background:#c80;border-color:#a60;font-weight:bold}' +
      'a.sil-l-info{margin-right:6px;padding:0 5px;border:1px solid #888;border-radius:3px;text-decoration:none;' +
      'background:#eef;color:#225 !important;font:bold 14px Arial,sans-serif;cursor:pointer}' +
      'a.sil-l-info.sil-nf{background:#fee;color:#a55 !important;border-color:#dbb;font-size:9px;font-weight:normal}';
    document.head.appendChild(st);
    const { openAll, openNext, hide } = makeToolbar(true);
    const entries = items.map((el) => {
      const t = el.querySelector(ls.title);
      const m = t && LCODE_RE.exec(t.textContent + ' ' + (t.getAttribute('title') || ''));
      return { el, t, key: m ? normKey(m[1], m[2]) : null, badge: null };
    });
    // ℹ link before each title: finds the scene's description page (same lookup as on sukebei)
    entries.forEach((e) => {
      if (!e.key || !e.t) return;
      const [kp, kn] = e.key.split('-');
      if (getIgnored().includes(kp.toUpperCase())) return;
      const link = document.createElement('a');
      link.className = 'sil-l-info'; link.href = '#'; link.textContent = 'ℹ';
      // long ids (e.g. "AV-1399778673") can't be found on the lookup sites: the scene page of this site is the info page
      if (kn.length > 6) {
        link.href = e.t.href; link.target = '_blank'; link.rel = 'noopener';
        link.title = 'Open the scene page ' + e.key.toUpperCase();
        e.t.insertAdjacentElement('beforebegin', link);
        return;
      }
      link.title = 'Find info for ' + e.key.toUpperCase();
      const paintInfo = () => { const nf = !!getNF()[e.key]; link.classList.toggle('sil-nf', nf); link.textContent = nf ? 'ℹ✗' : 'ℹ'; };
      paintInfo();
      let busy = false;
      link.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (busy) return;
        busy = true;
        const tab = window.open('about:blank', '_blank'); // inside the click, so popup blockers allow it
        link.textContent = '…';
        const found = await findScene(e.key, (name) => { link.title = 'Trying ' + name + '…'; });
        markNF(e.key, found);
        paintInfo();
        if (tab) tab.location.href = found || 'https://www.google.com/search?q=' + encodeURIComponent(e.key);
        busy = false;
      });
      e.t.insertAdjacentElement('beforebegin', link);
    });
    const seenSet = () => new Set(Object.keys(getOpened()).map((c) => { const [p, n] = c.split('-'); return normKey(p, n); }));
    // keys of the wanted scenes (by the code saved with each entry, or found in its URL)
    const wantedKeys = () => new Set(Object.values(getWanted()).map((w) => {
      const m = LCODE_RE.exec(w.code || codeIn(w.url)); return m ? normKey(m[1], m[2]) : null;
    }).filter(Boolean));
    function apply() {
      const seen = seenSet(), want = wantedKeys();
      let n = 0;
      entries.forEach((e) => {
        // wanted scenes keep full visibility (never greyed out or hidden) and get a ★ badge
        const wanted = !!(e.t && ((e.key && want.has(e.key)) || isWanted(e.t.href)));
        const is = !wanted && !!(e.key && seen.has(e.key));
        e.el.classList.toggle('sil-l-seen', is);
        if (is) n++;
        const text = wanted ? '★ wanted' : is ? '✓ seen' : '';
        if (text && e.t) {
          if (!e.badge) { e.badge = document.createElement('span'); e.t.parentNode.insertBefore(e.badge, e.t); }
          e.badge.className = 'sil-l-badge' + (wanted ? ' sil-l-want' : '');
          e.badge.textContent = text;
        } else if (!text && e.badge) { e.badge.remove(); e.badge = null; }
      });
      const h = GM_getValue(hideKey, true);
      document.body.classList.toggle('sil-l-hide', h);
      hide.textContent = (h ? 'Show seen' : 'Hide seen') + ' (' + n + ')';
    }
    hide.addEventListener('click', () => { GM_setValue(hideKey, !GM_getValue(hideKey, true)); apply(); });
    openAll.addEventListener('click', () => {
      const seen = seenSet();
      const todo = entries.filter((e) => e.key && e.t && e.t.href && !seen.has(e.key) && e.el.offsetParent !== null);
      if (!todo.length) { alert('Nothing unchecked to open.'); return; }
      if (getSortAlpha()) todo.sort((x, y) => x.key.localeCompare(y.key, undefined, { numeric: true }));
      todo.reverse(); // new tabs are inserted right after this one
      todo.forEach((e) => GM_openInTab(e.t.href, { active: false, insert: true }));
    });
    // "Open next N": unseen scenes of this page first, then of the following pages (/page/2/, /page/3/...).
    // From page 1, it resumes a few pages before the last page it picked from last time (remembered per listing).
    const pageOf = (href) => { const m = /\/page\/(\d+)\/?$/.exec(new URL(href).pathname); return m ? parseInt(m[1], 10) : 1; };
    const listBase = (u) => {
      let path = u.pathname.replace(/\/page\/\d+\/?$/, '/').replace(/\/?$/, '/');
      if (path === '/' && /myjavbay\.com$/.test(u.hostname)) path = '/index.php/';
      return path;
    };
    const pageUrl = (href, n) => {
      const u = new URL(href);
      u.pathname = listBase(u) + (n > 1 ? 'page/' + n + '/' : '');
      u.hash = '';
      return u.href;
    };
    const memKey = () => { const u = new URL(location.href); return u.hostname + listBase(u); };
    const LIMIT = getOpenNext();
    let busyNext = false;
    if (openNext) openNext.addEventListener('click', async () => {
      if (busyNext) return;
      busyNext = true;
      const label = openNext.textContent;
      try {
        const seen = seenSet(), want = wantedKeys();
        const picked = [], keys = new Set();
        const cur = pageOf(location.href);
        let lastPickPage = 0;
        const consider = (key, href, page) => {
          if (picked.length >= LIMIT || !key || !href || keys.has(key)) return;
          if (seen.has(key) || want.has(key) || isWanted(href)) return;
          keys.add(key); picked.push({ key, href }); lastPickPage = Math.max(lastPickPage, page);
        };
        entries.forEach((e) => { if (e.el.offsetParent !== null && e.t) consider(e.key, e.t.href, cur); });
        // from page 1, skip the pages that were already worked through last time
        const mem = GM_getValue(LASTP, {})[memKey()] || 0;
        let page = cur + 1;
        if (cur === 1 && mem - RESUME_BACK_PAGES > page) page = mem - RESUME_BACK_PAGES;
        const firstPage = page;
        let fetched = 0, stop = '';
        while (picked.length < LIMIT && fetched < 40) {
          openNext.textContent = (page === firstPage && firstPage > cur + 1 ? 'Resuming at page ' : 'Page ') + page +
                                 '… (' + picked.length + '/' + LIMIT + ')';
          const url = pageUrl(location.href, page);
          const r = await get(url);
          fetched++;
          if (r.status !== 200) { stop = r.status === 404 ? 'No more pages.' : 'Page ' + page + ' failed (HTTP ' + r.status + ').'; break; }
          const doc = new DOMParser().parseFromString(r.text, 'text/html');
          const els = [...doc.querySelectorAll(ls.item)];
          if (!els.length) { stop = 'No more pages.'; break; }
          els.forEach((el) => {
            const t = el.querySelector(ls.title);
            const m = t && LCODE_RE.exec(t.textContent + ' ' + (t.getAttribute('title') || ''));
            if (m) consider(normKey(m[1], m[2]), new URL(t.getAttribute('href'), url).href, page);
          });
          page++;
        }
        if (lastPickPage) { // remember where we got to (from page 1 this is authoritative, otherwise keep the furthest)
          const all = GM_getValue(LASTP, {});
          all[memKey()] = cur === 1 ? lastPickPage : Math.max(all[memKey()] || 0, lastPickPage);
          GM_setValue(LASTP, all);
        }
        if (!picked.length) { alert('Nothing unseen to open.' + (stop ? ' ' + stop : '')); return; }
        if (picked.length < LIMIT && stop) alert('Only ' + picked.length + ' unseen scenes found. ' + stop);
        if (getSortAlpha()) picked.sort((x, y) => x.key.localeCompare(y.key, undefined, { numeric: true }));
        picked.reverse(); // new tabs are inserted right after this one
        picked.forEach((e) => GM_openInTab(e.href, { active: false, insert: true }));
      } finally {
        openNext.textContent = label;
        busyNext = false;
      }
    });
    window.addEventListener('focus', apply);
    document.addEventListener('visibilitychange', apply);
    if (typeof GM_addValueChangeListener === 'function') { GM_addValueChangeListener(KEY, apply); GM_addValueChangeListener(WANT, apply); }
    apply();
  }

  // HTTP GET through the userscript manager (cross-origin), used for the site lookups.
  const get = (url) => new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET', url, timeout: TIMEOUT_MS,
      onload: (r) => resolve({ status: r.status, text: r.responseText || '', url: r.finalUrl || url }),
      onerror: () => resolve({ status: 0, text: '' }),
      ontimeout: () => resolve({ status: 0, text: '' }),
    });
  });

  // ---- site error reporting: a toast in the corner (one per site + error, with a counter) ----
  // cooldown shared by every tab (stored): { siteName: timestamp until which it is skipped }
  const CD = 'siteCooldown';
  const coolingUntil = (name) => (GM_getValue(CD, {})[name] || 0);
  const startCooldown = (name) => { const c = GM_getValue(CD, {}); c[name] = Date.now() + COOLDOWN_MS; GM_setValue(CD, c); };
  const errCodes = new Set(); // codes whose lookup hit a site error: not recorded as "not found"
  const markNF = (code, found) => {
    if (found) { errCodes.delete(code); setNF(code, false); return; }
    if (errCodes.has(code)) return; // a site failed: the scene may exist, don't remember it as not found
    setNF(code, true);
  };
  const toasts = {};
  let toastBox = null;
  function siteError(site, status, detail) {
    const why = status === 0 ? 'no response (timeout / connection refused)'
      : status === 429 ? 'rate limited (HTTP 429)'
      : status === 403 ? 'access denied (HTTP 403)'
      : status === 200 ? (detail || 'anti-bot / captcha page')
      : 'HTTP ' + status;
    const key = site + '|' + why;
    if (!toastBox) {
      const ui = shadowUI('display:block;position:fixed;bottom:8px;right:8px;z-index:2147483647;');
      toastBox = mk('div', 'display:flex;flex-direction:column;gap:4px;align-items:flex-end');
      ui.root.appendChild(toastBox);
      document.body.appendChild(ui.host);
    }
    let t = toasts[key];
    if (!t) {
      const el = mk('div', 'max-width:360px;background:#a33;color:#fff;padding:8px 10px;border-radius:6px;' +
        'font:13px Arial,sans-serif;box-shadow:0 2px 8px #0008;cursor:pointer');
      el.title = 'Click to dismiss';
      t = toasts[key] = { el, n: 0 };
      el.addEventListener('click', () => { el.remove(); delete toasts[key]; });
      toastBox.appendChild(el);
    }
    t.n++;
    t.el.textContent = '⚠ ' + site + ': ' + why + (t.n > 1 ? ' (x' + t.n + ')' : '') +
      '. Your IP may be blocked or limited: skipping this site for ' + Math.round(COOLDOWN_MS / 60000) + ' min, trying the others.';
  }
  const BLOCK_RE = /just a moment|cf-chrome|captcha|access denied|attention required|too many requests/i;

  migrateOpened();

  // ======================= LISTING / DESTINATION SITES =======================
  if (!/(^|\.)nyaa\.si$/.test(location.hostname)) {
    const ls = LIST_SITES.find((x) => location.hostname === x.domain || location.hostname.endsWith('.' + x.domain));
    const titleText = () => ((document.querySelector('h1.entry-title, h1.post-title, h1.title, h1') || {}).textContent || '') + ' ' + document.title;
    const pageCode = () => { const m = LCODE_RE.exec(titleText()); return m ? m[1].toUpperCase() + '-' + m[2] : null; };
    // sukebei info for a lookup destination (matched by code in the URL / title)
    const savedInfo = () => {
      const links = GM_getValue(LINKS, {});
      const c = Object.keys(links)
        .filter((k) => codeRegex(k).test(location.href) || codeRegex(k).test(document.title))
        .sort((a, b) => links[b].t - links[a].t)[0];
      return c ? { code: c.toUpperCase(), info: links[c] } : null;
    };

    if (ls) {
      if (ls.detail.test(location.pathname)) {                       // a single-scene page
        const code = pageCode();
        const saved = ls.alsoDestination ? savedInfo() : null;
        let info = saved ? saved.info : null;
        if (ls.qb) {                                                 // take the magnet link from the page
          const mg = document.querySelector('a[href^="magnet:"]');
          if (mg) info = { magnet: mg.href, torrent: null, view: location.href };
        }
        if (code || saved) detailBox({ code: code || saved.code, info, want: !!ls.want });
        return;
      }
      const items = [...document.querySelectorAll(ls.item)];
      if (items.length >= 2) listMode(ls, items);                    // a listing page
      return;
    }
    // other lookup destinations (jvrlibrary, javdatabase, r18...): sukebei torrent box
    const saved = savedInfo();
    if (saved) detailBox({ code: saved.code, info: saved.info, want: false });
    return;
  }

  // ============================ NYAA SIDE ============================
  // Returns the URL of the first site that has the scene, or null.
  // Per-site throttle: waits until `site.delay` ms (default 0) have passed since the last request to that site.
  const lastReq = {};
  async function throttle(site) {
    const wait = (lastReq[site.name] || 0) + (site.delay || 0) - Date.now();
    lastReq[site.name] = Date.now() + Math.max(0, wait); // reserve the slot so concurrent lookups queue up
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  }

  async function findScene(code, onProgress) {
    const [prefix, num] = code.split('-');
    const re = codeRegex(code);
    let hadError = false;
    errCodes.delete(code);
    for (const site of SITES) {
      if (Date.now() < coolingUntil(site.name)) { hadError = true; continue; } // cooling down after an error
      for (const url of site.probe(prefix, num)) {
        onProgress && onProgress(site.name);
        await throttle(site);
        const r = await get(url);
        if (r.status !== 200) {
          if (r.status !== 404) { siteError(site.name, r.status); hadError = true; startCooldown(site.name); break; }
          continue;
        }
        if (BLOCK_RE.test(r.text.slice(0, 3000)) && !re.test(r.text)) { siteError(site.name, 200); hadError = true; startCooldown(site.name); break; }
        if (site.search) {
          const doc = new DOMParser().parseFromString(r.text, 'text/html');
          for (const a of doc.querySelectorAll('a[href]')) {
            let u; try { u = new URL(a.getAttribute('href'), url); } catch (e) { continue; }
            if (u.pathname !== '/' && !u.search && re.test(u.pathname) && (!site.detail || site.detail.test(u.pathname))) { u.hash = ''; return u.href; }
          }
        } else if (site.noVerify || re.test(r.text)) {
          return r.url || url;
        }
      }
    }
    if (hadError) errCodes.add(code);
    return null;
  }


  const STYLE = document.createElement('style');
  STYLE.textContent = `
    a.sil-link { margin-right:6px; padding:0 5px; border:1px solid #888; border-radius:3px;
                 text-decoration:none; background:#eef; color:#225 !important;
                 font:bold 14px Arial,sans-serif; cursor:pointer; }
    a.sil-link.sil-seen { background:#eee; color:#888 !important; border-color:#ccc;
                          font-size:9px; font-weight:normal; }
    a.sil-link.sil-nf { background:#fee; color:#a55 !important; border-color:#dbb;
                        font-size:9px; font-weight:normal; }
    tr.sil-seen a[href^="/view/"]:not(.comments):not(.sil-link),
    tr.sil-nf a[href^="/view/"]:not(.comments):not(.sil-link),
    tr.sil-nocode a[href^="/view/"]:not(.comments):not(.sil-link) { opacity:.55; }
    body.sil-hide tr.sil-old { display:none; }
  `;
  document.head.appendChild(STYLE);

  // state: 'seen' (found), 'nf' (not found anywhere) or '' (unchecked)
  const stateOf = (code, o, nf) => {
    const [p, n] = code.split('-');
    return o[normKey(p, n)] ? 'seen' : nf[code] ? 'nf' : '';
  };
  function paint(link, row, state) {
    link.classList.toggle('sil-seen', state === 'seen');
    link.classList.toggle('sil-nf', state === 'nf');
    link.textContent = state === 'seen' ? 'ℹ✓' : state === 'nf' ? 'ℹ✗' : 'ℹ';
    if (row) { row.classList.toggle('sil-seen', state === 'seen'); row.classList.toggle('sil-nf', state === 'nf'); }
  }

  // "hide checked rows": applies to rows already checked when toggled/loaded,
  // so a row you just clicked doesn't vanish under your cursor.
  const { openAll: openAllBtn, openNext: openNextBtn, hide: btn } = makeToolbar(!!document.querySelector('table.torrent-list'));
  function applyHide() {
    const hide = GM_getValue('hideSeen', true);
    document.querySelectorAll('tr.sil-old').forEach((r) => r.classList.remove('sil-old'));
    if (hide) document.querySelectorAll('tr.sil-seen, tr.sil-nf, tr.sil-nocode').forEach((r) => r.classList.add('sil-old'));
    document.body.classList.toggle('sil-hide', hide);
    const n = document.querySelectorAll('tr.sil-seen, tr.sil-nf, tr.sil-nocode').length;
    btn.textContent = (hide ? 'Show' : 'Hide') + ' checked rows (' + n + ')';
  }
  btn.addEventListener('click', () => { GM_setValue('hideSeen', !GM_getValue('hideSeen', true)); applyHide(); });

  const registry = [];
  function refresh() {
    const o = getOpened(), nf = getNF();
    registry.forEach((r) => paint(r.link, r.row, stateOf(r.code, o, nf)));
  }
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  if (typeof GM_addValueChangeListener === 'function') { GM_addValueChangeListener(KEY, refresh); GM_addValueChangeListener(NF, refresh); }

  function decorate(titleEl, row) {
    if (titleEl.dataset.silDone) return;
    const m = CODE_RE.exec(titleEl.textContent);
    titleEl.dataset.silDone = '1';
    const scope = row || document;
    const collect = () => {
      const t = scope.querySelector('a[href$=".torrent"], a[href^="/download/"]');
      const mg = scope.querySelector('a[href^="magnet:"]');
      return { torrent: t && t.href, magnet: mg && mg.href,
               view: row ? (titleEl.href || location.href) : location.href };
    };
    if (!m || getIgnored().includes(m[1].toUpperCase())) { if (row) row.classList.add('sil-nocode'); return; }
    const code = (m[1] + '-' + m[2]).toLowerCase();
    const link = document.createElement('a');
    link.className = 'sil-link';
    link.href = '#';
    link.title = `Find info for ${code.toUpperCase()}`;
    paint(link, row, stateOf(code, getOpened(), getNF()));

    let busy = false;
    // Probe the sites and navigate `tab` (opened inside a user click) to the result.
    // Without `tab`, a found page is opened in a background tab (no popup blocker).
    // Looks the scene up (and updates the ✓/✗ state). Returns the URL found, or null.
    const lookup = async () => {
      if (busy) return null;
      busy = true;
      saveLinks(code, collect());
      link.textContent = '…';
      const found = await findScene(code, (name) => { link.title = 'Trying ' + name + '…'; });
      markNF(code, found); // "seen" is set later, by a decision on the scene's page
      if (!found) link.title = errCodes.has(code) ? 'Lookup failed (site error), try again later' : 'Not found on any site';
      paint(link, row, stateOf(code, getOpened(), getNF()));
      busy = false;
      return found;
    };
    const run = async (tab) => {
      if (busy) { if (tab) tab.close(); return false; }
      const found = await lookup();
      if (found) {
        if (tab) tab.location.href = found; else GM_openInTab(found, { active: false, insert: true });
      } else if (tab) {
        // plain Google search so the tab isn't empty
        tab.location.href = 'https://www.google.com/search?q=' + encodeURIComponent(code);
      }
      return !!found;
    };
    const onUse = (ev) => {
      if (ev.type === 'auxclick' && ev.button !== 1) return;
      ev.preventDefault();
      if (busy) return;
      // Open the tab now (inside the click) so popup blockers allow it.
      run(window.open('about:blank', '_blank'));
    };
    registry.push({ code, link, row, run, lookup, isBusy: () => busy });
    link.addEventListener('click', onUse);
    link.addEventListener('auxclick', onUse);
    titleEl.insertAdjacentElement('beforebegin', link);
  }

  const pending = () => {
    const o = getOpened(), nf = getNF();
    return registry.filter((r) => r.row && !r.isBusy() && !stateOf(r.code, o, nf) &&
                                  r.row.offsetParent !== null);
  };

  openAllBtn.addEventListener('click', () => {
    const todo = pending();
    if (!todo.length) { alert('Nothing unchecked to open.'); return; }
    if (getSortAlpha()) todo.sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
    // Each new background tab is inserted right after this page, pushing the earlier ones
    // to the right. So open them in REVERSE order to end up with the wanted order left-to-right.
    todo.reverse();
    // Look scenes up PARALLEL at a time, but open the tabs strictly in that sequence.
    const results = todo.map(() => null);
    const ready = todo.map((_, i) => new Promise((res) => { results[i] = res; }));
    let next = 0;
    const worker = async () => {
      while (next < todo.length) { const i = next++; results[i](await todo[i].lookup()); }
    };
    for (let i = 0; i < PARALLEL; i++) worker();
    (async () => {
      for (const p of ready) {
        const url = await p;
        if (url) GM_openInTab(url, { active: false, insert: true });
      }
    })();
  });

  // "Open next N" on sukebei: the unchecked scenes of this page, then of the following pages (?p=2, ?p=3...).
  // Each scene is looked up (PARALLEL at a time) and only scenes that have a description page count toward N.
  // From page 1 it resumes near the last page it picked from (remembered per search).
  if (openNextBtn) {
    const LIMIT = getOpenNext();
    const pageOf = (href) => parseInt(new URL(href).searchParams.get('p'), 10) || 1;
    const pageUrl = (href, n) => { const u = new URL(href); if (n > 1) u.searchParams.set('p', n); else u.searchParams.delete('p'); u.hash = ''; return u.href; };
    const memKey = () => { const u = new URL(location.href); u.searchParams.delete('p'); u.searchParams.sort(); return u.hostname + u.pathname + u.search; };
    // unchecked scenes of a fetched page (same rules as the page itself): [{ code, lookup }]
    const candidatesOf = (doc, base, page, seenKeys) => {
      const o = getOpened(), nf = getNF(), out = [];
      let rows = 0, sig = '';
      doc.querySelectorAll('table.torrent-list tbody tr').forEach((row) => {
        const a = row.querySelector('td[colspan="2"] a:not(.comments)');
        if (!a) return;
        rows++;
        sig += a.getAttribute('href') + '|'; // page signature: sukebei repeats the last page past its 1000-result limit
        const m = CODE_RE.exec(a.textContent);
        if (!m || getIgnored().includes(m[1].toUpperCase())) return;
        const code = (m[1] + '-' + m[2]).toLowerCase();
        const k = normKey(m[1], m[2]);
        if (stateOf(code, o, nf) || seenKeys.has(k)) return;
        seenKeys.add(k);
        const t = row.querySelector('a[href$=".torrent"], a[href^="/download/"]');
        const mg = row.querySelector('a[href^="magnet:"]');
        const info = { torrent: t && new URL(t.getAttribute('href'), base).href, magnet: mg && mg.getAttribute('href'),
                       view: new URL(a.getAttribute('href'), base).href };
        out.push({ code, page, lookup: async () => {
          saveLinks(code, info);
          const found = await findScene(code);
          markNF(code, found);
          return found;
        } });
      });
      return { out, rows, sig };
    };
    let busyNext = false;
    openNextBtn.addEventListener('click', async () => {
      if (busyNext) return;
      busyNext = true;
      const label = openNextBtn.textContent;
      try {
        const cur = pageOf(location.href);
        const seenKeys = new Set();
        const queue = [];      // candidates waiting for their lookup
        const found = [];      // { code, url, page, opened }
        const sortAlpha = getSortAlpha(); // alphabetical order needs all results first, so tabs open at the end
        const lookupBatch = async (batch) => {
          let i = 0;
          const worker = async () => {
            while (i < batch.length) {
              const c = batch[i++];
              const url = await c.lookup();
              if (url) {
                const f = { code: c.code, url, page: c.page };
                found.push(f);
                if (!sortAlpha) { f.opened = true; GM_openInTab(url, { active: false, insert: true }); } // open as soon as found
              }
              openNextBtn.textContent = 'Looking up… (' + found.length + '/' + LIMIT + ')';
            }
          };
          await Promise.all(Array.from({ length: PARALLEL }, worker));
        };
        // this page (rows already on screen, with their ℹ links)
        pending().forEach((r) => {
          const k = r.code.split('-'); seenKeys.add(normKey(k[0], k[1]));
          queue.push({ code: r.code, page: cur, lookup: r.lookup });
        });
        const mem = GM_getValue(LASTP, {})[memKey()] || 0;
        let page = cur + 1;
        if (cur === 1 && mem - RESUME_BACK_PAGES > page) page = mem - RESUME_BACK_PAGES;
        const firstPage = page;
        let fetched = 0, stop = '', lastSig = '';
        while (found.length < LIMIT) {
          if (queue.length) {                                  // look up only as many as are still needed
            await lookupBatch(queue.splice(0, LIMIT - found.length));
            continue;
          }
          if (stop || fetched >= 40) break;                    // queue drained, and no more pages
          openNextBtn.textContent = (page === firstPage && firstPage > cur + 1 ? 'Resuming at page ' : 'Page ') + page +
                                    '… (' + found.length + '/' + LIMIT + ')';
          const url = pageUrl(location.href, page);
          const r = await get(url);
          fetched++;
          if (r.status !== 200) { stop = r.status === 404 ? 'No more pages.' : 'Page ' + page + ' failed (HTTP ' + r.status + ').'; continue; }
          const c = candidatesOf(new DOMParser().parseFromString(r.text, 'text/html'), url, page, seenKeys);
          if (!c.rows || c.sig === lastSig) { stop = 'No more pages.'; continue; }
          lastSig = c.sig;
          queue.push(...c.out);
          page++;
        }
        const lastPickPage = found.reduce((mx, f) => Math.max(mx, f.page), 0);
        if (lastPickPage) {
          const all = GM_getValue(LASTP, {});
          all[memKey()] = cur === 1 ? lastPickPage : Math.max(all[memKey()] || 0, lastPickPage);
          GM_setValue(LASTP, all);
        }
        if (!found.length) { alert('Nothing to open.' + (stop ? ' ' + stop : '')); return; }
        if (found.length < LIMIT && stop) alert('Only ' + found.length + ' scenes found. ' + stop);
        if (sortAlpha) found.sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
        found.reverse(); // new tabs are inserted right after this one
        found.filter((f) => !f.opened).forEach((f) => GM_openInTab(f.url, { active: false, insert: true }));
      } finally {
        openNextBtn.textContent = label;
        busyNext = false;
      }
    });
  }

  // listing page
  document.querySelectorAll('table.torrent-list tbody tr').forEach((row) => {
    const a = row.querySelector('td[colspan="2"] a:not(.comments)');
    if (a) decorate(a, row);
  });
  // single torrent page
  const h = document.querySelector('.panel-title');
  if (h && /^\/view\//.test(location.pathname)) decorate(h, null);

  applyHide();

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Clear opened-scenes history', () => {
      if (confirm('Forget all opened scenes?')) { GM_setValue(KEY, {}); GM_setValue(NF, {}); GM_setValue(LASTP, {}); location.reload(); }
    });
    GM_registerMenuCommand('Set qBittorrent Web UI', qbSetup);
    GM_registerMenuCommand('Set ignored code prefixes', () => {
      const t = prompt('Ignored code prefixes, comma-separated:', getIgnored().join(', '));
      if (t !== null) { GM_setValue(IGN, parsePrefixes(t)); location.reload(); }
    });
    GM_registerMenuCommand('Forget "Open next" remembered pages', () => { GM_setValue(LASTP, {}); alert('Done: "Open next" will start from the current page again.'); });
    GM_registerMenuCommand('Show opened count', () =>
      alert(Object.keys(getOpened()).length + ' scenes opened'));
  }
})();
