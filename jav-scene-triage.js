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
  const TIMEOUT_MS = 15000;  // per-request timeout (site lookups and qBittorrent)
  // qBittorrent address/login: and the share-ratio limit: use the "⚙" button in the box on the description page.

  // ------------------------------------------------------------------
  // CONFIG: sites in priority order. `probe(prefix, num)` returns the list of
  // candidate URLs to test (prefix is lowercase, num is as written on sukebei).
  // A candidate is accepted when it answers HTTP 200 and the page text
  // contains the code (fuzzy on leading zeros). `search: true` means the URL
  // is a search page: we parse the first result link containing the code.
  // ------------------------------------------------------------------
  const pad = (n, w) => String(n).padStart(w, '0');
  const SITES = [
    { name: 'jvrlibrary',
      probe: (p, n) => [`https://www.jvrlibrary.com/jvr?id=${p.toUpperCase()}-${n}`] },
    { name: 'javdatabase',
      probe: (p, n) => uniq([`https://www.javdatabase.com/movies/${p}-${n}/`,
                             `https://www.javdatabase.com/movies/${p}-${pad(n, 5)}/`]) },
    { name: 'r18.dev', noVerify: true, // page is rendered by JS: status only
      probe: (p, n) => uniq([`https://r18.dev/videos/vod/movies/detail/-/id=${p}${pad(n, 5)}/`,
                             `https://r18.dev/videos/vod/movies/detail/-/id=${p}${n}/`]) },
    { name: 'maxjav', search: true,
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
  const CODE_RE = /\b((?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,10})-(\d{2,5})\b/;
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

  // Normalised key so "VRKM-01941" and "vrkm-1941" are the same scene.
  const LCODE_RE = /\b((?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{2,10})-(\d{2,5})\b/;
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
  const BAR_BTN = 'padding:2px 8px;font:12px Arial,sans-serif;border:1px solid #888;border-radius:3px;' +
    'background:#fff;color:#333;cursor:pointer;margin:0';
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
      GM_setValue(QB, c.url === '' ? null : c); // empty address = qBittorrent not configured
      onDone();
    });
    cancel.addEventListener('click', onDone);

    const wrap = mk('div');
    wrap.append(ign.wrap, sortWrap,
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

  // --------------------- toolbar (top right, every list page) ---------------------
  // Returns the buttons; callers attach behaviour to openAll / hide.
  function makeToolbar() {
    const { host, root } = shadowUI('display:block;position:fixed;top:6px;right:6px;z-index:2147483647;');
    const bar = mk('div', 'display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap');
    const bb = (text, title) => { const b = mk('button', BAR_BTN, text); if (title) b.title = title; return b; };
    const openAll = bb('Open all unchecked');
    const hide = bb('');
    const wanted = bb('★ Wanted', 'Scenes marked "I want"');
    const gear = bb('⚙', 'Settings (qBittorrent, ignored prefixes…)');
    bar.append(openAll, hide, wanted, gear);
    const below = mk('div', 'margin-top:4px;display:flex;flex-direction:column;align-items:flex-end;gap:4px');
    root.append(bar, below);

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
    return { openAll, hide };
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
      if (want) {
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
      'a.sil-l-info{margin-right:6px;padding:0 5px;border:1px solid #888;border-radius:3px;text-decoration:none;' +
      'background:#eef;color:#225 !important;font:bold 14px Arial,sans-serif;cursor:pointer}' +
      'a.sil-l-info.sil-nf{background:#fee;color:#a55 !important;border-color:#dbb;font-size:9px;font-weight:normal}';
    document.head.appendChild(st);
    const { openAll, hide } = makeToolbar();
    const entries = items.map((el) => {
      const t = el.querySelector(ls.title);
      const m = t && LCODE_RE.exec(t.textContent + ' ' + (t.getAttribute('title') || ''));
      return { el, t, key: m ? normKey(m[1], m[2]) : null, badge: null };
    });
    // ℹ link before each title: finds the scene's description page (same lookup as on sukebei)
    entries.forEach((e) => {
      if (!e.key || !e.t) return;
      const link = document.createElement('a');
      link.className = 'sil-l-info'; link.href = '#'; link.textContent = 'ℹ';
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
        setNF(e.key, !found);
        paintInfo();
        if (tab) tab.location.href = found || 'https://www.google.com/search?q=' + encodeURIComponent(e.key);
        busy = false;
      });
      e.t.insertAdjacentElement('beforebegin', link);
    });
    const seenSet = () => new Set(Object.keys(getOpened()).map((c) => { const [p, n] = c.split('-'); return normKey(p, n); }));
    function apply() {
      const seen = seenSet();
      let n = 0;
      entries.forEach((e) => {
        const is = !!(e.key && seen.has(e.key));
        e.el.classList.toggle('sil-l-seen', is);
        if (is) n++;
        if (is && !e.badge && e.t) {
          e.badge = document.createElement('span'); e.badge.className = 'sil-l-badge'; e.badge.textContent = '✓ seen';
          e.t.parentNode.insertBefore(e.badge, e.t);
        } else if (!is && e.badge) { e.badge.remove(); e.badge = null; }
      });
      const h = GM_getValue(hideKey, false);
      document.body.classList.toggle('sil-l-hide', h);
      hide.textContent = (h ? 'Show seen' : 'Hide seen') + ' (' + n + ')';
    }
    hide.addEventListener('click', () => { GM_setValue(hideKey, !GM_getValue(hideKey, false)); apply(); });
    openAll.addEventListener('click', () => {
      const seen = seenSet();
      const todo = entries.filter((e) => e.key && e.t && e.t.href && !seen.has(e.key) && e.el.offsetParent !== null);
      if (!todo.length) { alert('Nothing unchecked to open.'); return; }
      if (getSortAlpha()) todo.sort((x, y) => x.key.localeCompare(y.key, undefined, { numeric: true }));
      todo.reverse(); // new tabs are inserted right after this one
      todo.forEach((e) => GM_openInTab(e.t.href, { active: false, insert: true }));
    });
    window.addEventListener('focus', apply);
    document.addEventListener('visibilitychange', apply);
    if (typeof GM_addValueChangeListener === 'function') GM_addValueChangeListener(KEY, apply);
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
  async function findScene(code, onProgress) {
    const [prefix, num] = code.split('-');
    const re = codeRegex(code);
    for (const site of SITES) {
      for (const url of site.probe(prefix, num)) {
        onProgress && onProgress(site.name);
        const r = await get(url);
        if (r.status !== 200) continue;
        if (site.search) {
          const doc = new DOMParser().parseFromString(r.text, 'text/html');
          for (const a of doc.querySelectorAll('a[href]')) {
            let u; try { u = new URL(a.getAttribute('href'), url); } catch (e) { continue; }
            if (u.pathname !== '/' && !u.search && re.test(u.pathname)) return u.href;
          }
        } else if (site.noVerify || re.test(r.text)) {
          return r.url || url;
        }
      }
    }
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
  const { openAll: openAllBtn, hide: btn } = makeToolbar();
  function applyHide() {
    const hide = GM_getValue('hideSeen', false);
    document.querySelectorAll('tr.sil-old').forEach((r) => r.classList.remove('sil-old'));
    if (hide) document.querySelectorAll('tr.sil-seen, tr.sil-nf, tr.sil-nocode').forEach((r) => r.classList.add('sil-old'));
    document.body.classList.toggle('sil-hide', hide);
    const n = document.querySelectorAll('tr.sil-seen, tr.sil-nf, tr.sil-nocode').length;
    btn.textContent = (hide ? 'Show' : 'Hide') + ' checked rows (' + n + ')';
  }
  btn.addEventListener('click', () => { GM_setValue('hideSeen', !GM_getValue('hideSeen', false)); applyHide(); });

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
    if (!m || getIgnored().includes(m[1])) { if (row) row.classList.add('sil-nocode'); return; }
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
      if (found) setNF(code, false); // "seen" is set later, by a decision on the scene's page
      else { setNF(code, true); link.title = 'Not found on any site'; }
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
      if (confirm('Forget all opened scenes?')) { GM_setValue(KEY, {}); GM_setValue(NF, {}); location.reload(); }
    });
    GM_registerMenuCommand('Set qBittorrent Web UI', qbSetup);
    GM_registerMenuCommand('Set ignored code prefixes', () => {
      const t = prompt('Ignored code prefixes, comma-separated:', getIgnored().join(', '));
      if (t !== null) { GM_setValue(IGN, parsePrefixes(t)); location.reload(); }
    });
    GM_registerMenuCommand('Show opened count', () =>
      alert(Object.keys(getOpened()).length + ' scenes opened'));
  }
})();
