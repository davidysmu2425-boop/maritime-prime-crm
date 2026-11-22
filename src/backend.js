// Maritime Prime CRM - shared data layer.
// Talks to Supabase (logins, database, file storage) and keeps every signed-in
// office device in sync. The screens themselves live in index.html.
(function () {
  'use strict';

  var cfg = window.CRM_CONFIG || {};
  var demo = /[?&]demo(=|&|$)/.test(location.search);
  var configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  var sb = (!demo && configured && window.supabase)
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
    : null;

  var BUCKET = 'job-files';
  var COLLS = ['leads', 'jobs', 'workers', 'staff'];      // one row per record
  var SETTINGS = ['crews', 'autos', 'sentLog'];           // one row per setting
  var clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  var synced = {};      // table -> Map(id -> canonical JSON last known on the server)
  var blobs = {};       // file id -> File waiting to be uploaded
  var failed = {};      // file id -> true when an upload was refused
  var urlCache = {};    // storage path -> signed URL
  var channel = null;
  var chain = Promise.resolve();

  function resetMaps() {
    synced = { settings: new Map(), clocks: new Map() };
    COLLS.forEach(function (t) { synced[t] = new Map(); });
  }
  resetMaps();

  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).sort().forEach(function (k) { if (v[k] !== undefined) o[k] = sortKeys(v[k]); });
      return o;
    }
    return v;
  }
  function stable(v) { return JSON.stringify(sortKeys(v === undefined ? null : v)); }
  function idOf(t, r) { return t === 'staff' ? String(r.email || '').toLowerCase() : String(r.id); }
  function ok(res) { if (res.error) throw res.error; return res.data; }

  // What actually gets stored: never the temporary on-device preview URLs,
  // and never files that have not finished uploading.
  function clean(t, r) {
    if (t !== 'jobs' || !r.files) return r;
    var c = Object.assign({}, r);
    c.files = r.files.filter(function (f) { return f.path; }).map(function (f) {
      var x = Object.assign({}, f); delete x.url; return x;
    });
    return c;
  }
  function withUrls(jobs, prev) {
    var local = {};
    (prev || []).forEach(function (j) { (j.files || []).forEach(function (f) { if (f.url) local[f.id] = f.url; }); });
    return jobs.map(function (j) {
      if (!j.files || !j.files.length) return j;
      return Object.assign({}, j, { files: j.files.map(function (f) {
        if (f.url) return f;
        var u = local[f.id] || (f.path && urlCache[f.path]);
        return u ? Object.assign({}, f, { url: u }) : f;
      }) });
    });
  }

  // ---------- sign-in ----------
  async function init() {
    if (!sb) return null;
    return ok(await sb.auth.getSession()).session;
  }
  function onAuth(cb) { if (sb) sb.auth.onAuthStateChange(function (ev) { cb(ev); }); }
  function here() { return location.origin + location.pathname; }
  async function signIn(email, password) { return ok(await sb.auth.signInWithPassword({ email: email, password: password })); }
  async function signUp(email, password) { return ok(await sb.auth.signUp({ email: email, password: password, options: { emailRedirectTo: here() } })); }
  async function resetPassword(email) { return ok(await sb.auth.resetPasswordForEmail(email, { redirectTo: here() })); }
  async function setPassword(password) { return ok(await sb.auth.updateUser({ password: password })); }
  async function signOut() {
    unsubscribe(); resetMaps(); blobs = {}; failed = {}; urlCache = {};
    if (sb) { try { await sb.auth.signOut(); } catch (e) {} }
  }
  async function claim() { return ok(await sb.rpc('claim_profile')); }

  // ---------- office: load everything ----------
  async function loadAll() {
    var tables = ['leads', 'jobs', 'workers', 'staff', 'settings', 'clocks'];
    var res = await Promise.all(tables.map(function (t) { return sb.from(t).select('id,data'); }));
    var rows = {};
    tables.forEach(function (t, i) { rows[t] = ok(res[i]); });
    resetMaps();
    var out = {};
    COLLS.forEach(function (t) {
      out[t] = rows[t].map(function (r) { synced[t].set(r.id, stable(r.data)); return r.data; });
    });
    out.leads.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    out.jobs.sort(function (a, b) { return (parseInt(String(a.id).replace(/\D/g, ''), 10) || 0) - (parseInt(String(b.id).replace(/\D/g, ''), 10) || 0); });
    out.workers.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0) || String(a.name).localeCompare(String(b.name)); });
    var set = {};
    rows.settings.forEach(function (r) { set[r.id] = r.data; synced.settings.set(r.id, stable(r.data)); });
    out.crews = Array.isArray(set.crews) && set.crews.length ? set.crews : [{ name: 'Crew A', focus: 'General' }];
    out.autos = set.autos || {};
    out.sentLog = Array.isArray(set.sentLog) ? set.sentLog : [];
    out.clocks = {};
    rows.clocks.forEach(function (r) { out.clocks[r.id] = r.data; synced.clocks.set(r.id, stable(r.data)); });
    out.jobs = withUrls(out.jobs);
    return out;
  }

  // ---------- office: save what changed ----------
  function push(getState) {
    var run = chain.then(function () { return doPush(getState); });
    chain = run.catch(function () {});
    return run;
  }
  async function upload(jobId, f) {
    var folder = (f.kind === 'media' || f.kind === 'extra') ? f.kind : 'office';
    var path = jobId + '/' + folder + '/' + f.id + '-' + String(f.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
    var blob = blobs[f.id];
    var res = await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || undefined, upsert: false });
    if (res.error && !/exist/i.test(res.error.message || '')) throw res.error;
    delete blobs[f.id];
    return path;
  }
  async function doPush(getState) {
    if (!sb) return { changed: false, patches: [], failedFiles: [] };
    var s = getState(), patches = [], failedFiles = [], changed = false, now = new Date().toISOString();

    // 1. upload any new files, so the job record can point at them
    for (var a = 0; a < s.jobs.length; a++) {
      var fl = s.jobs[a].files || [];
      for (var b = 0; b < fl.length; b++) {
        var f = fl[b];
        if (f.path || !blobs[f.id] || failed[f.id]) continue;
        try { patches.push({ jobId: s.jobs[a].id, fileId: f.id, path: await upload(s.jobs[a].id, f) }); }
        catch (e) { failed[f.id] = true; failedFiles.push(f.name); console.warn('[crm] upload failed', f.name, e); }
      }
    }
    var jobs = !patches.length ? s.jobs : s.jobs.map(function (j) {
      if (!patches.some(function (p) { return p.jobId === j.id; })) return j;
      return Object.assign({}, j, { files: j.files.map(function (f) {
        var p = patches.find(function (x) { return x.fileId === f.id; });
        return p ? Object.assign({}, f, { path: p.path }) : f;
      }) });
    });

    // 2. records
    for (var c = 0; c < COLLS.length; c++) {
      var t = COLLS[c], list = t === 'jobs' ? jobs : (s[t] || []), cur = new Map(), ups = [], dels = [];
      list.forEach(function (r) { var id = idOf(t, r); if (id) cur.set(id, stable(clean(t, r))); });
      cur.forEach(function (str, id) { if (synced[t].get(id) !== str) ups.push({ id: id, data: JSON.parse(str), by: clientId, updated_at: now }); });
      synced[t].forEach(function (_, id) { if (!cur.has(id)) dels.push(id); });
      if (ups.length) { ok(await sb.from(t).upsert(ups)); ups.forEach(function (u) { synced[t].set(u.id, cur.get(u.id)); }); changed = true; }
      if (dels.length) { ok(await sb.from(t).delete().in('id', dels)); dels.forEach(function (id) { synced[t].delete(id); }); changed = true; }
    }

    // 3. settings and time clocks
    var sUps = [];
    SETTINGS.forEach(function (k) {
      if (s[k] === undefined || s[k] === null) return;
      var str = stable(s[k]);
      if (synced.settings.get(k) !== str) sUps.push({ id: k, data: JSON.parse(str), by: clientId, updated_at: now, _s: str });
    });
    if (sUps.length) {
      ok(await sb.from('settings').upsert(sUps.map(function (u) { return { id: u.id, data: u.data, by: u.by, updated_at: u.updated_at }; })));
      sUps.forEach(function (u) { synced.settings.set(u.id, u._s); }); changed = true;
    }
    var clocks = s.clocks || {}, cUps = [], cDels = [];
    Object.keys(clocks).forEach(function (id) { var str = stable(clocks[id]); if (synced.clocks.get(id) !== str) cUps.push({ id: id, data: clocks[id], by: clientId, updated_at: now, _s: str }); });
    synced.clocks.forEach(function (_, id) { if (!(id in clocks)) cDels.push(id); });
    if (cUps.length) {
      ok(await sb.from('clocks').upsert(cUps.map(function (u) { return { id: u.id, data: u.data, by: u.by, updated_at: u.updated_at }; })));
      cUps.forEach(function (u) { synced.clocks.set(u.id, u._s); }); changed = true;
    }
    if (cDels.length) { ok(await sb.from('clocks').delete().in('id', cDels)); cDels.forEach(function (id) { synced.clocks.delete(id); }); changed = true; }

    return { changed: changed, patches: patches, failedFiles: failedFiles };
  }

  // ---------- office: receive other people's changes live ----------
  function applyRemote(setState, t, id, data) {
    setState(function (st) {
      if (!st.session || st.session.kind !== 'account') return null;
      if (COLLS.indexOf(t) >= 0) {
        var m = synced[t], arr = st[t] || [], idx = -1;
        for (var i = 0; i < arr.length; i++) if (idOf(t, arr[i]) === id) { idx = i; break; }
        if (data === null) {
          if (!m.has(id)) return null;
          m.delete(id);
          if (idx < 0) return null;
          var o1 = {}; o1[t] = arr.filter(function (_, k) { return k !== idx; }); return o1;
        }
        var str = stable(data);
        if (idx >= 0) {
          var localStr = stable(clean(t, arr[idx]));
          if (m.has(id) && localStr !== m.get(id)) return null;   // unsaved edit here wins
          if (localStr === str) { m.set(id, str); return null; }
        }
        m.set(id, str);
        var rec = t === 'jobs' ? withUrls([data], idx >= 0 ? [arr[idx]] : [])[0] : data;
        var o2 = {};
        o2[t] = idx >= 0 ? arr.map(function (r, k) { return k === idx ? rec : r; }) : (t === 'leads' ? [rec].concat(arr) : arr.concat([rec]));
        return o2;
      }
      if (t === 'settings' && SETTINGS.indexOf(id) >= 0 && data !== null) {
        if (stable(st[id]) !== synced.settings.get(id) && synced.settings.has(id)) return null;
        synced.settings.set(id, stable(data));
        var o3 = {}; o3[id] = data; return o3;
      }
      if (t === 'clocks') {
        var clocks = Object.assign({}, st.clocks || {});
        if (data === null) { synced.clocks.delete(id); if (!(id in clocks)) return null; delete clocks[id]; }
        else { synced.clocks.set(id, stable(data)); clocks[id] = data; }
        return { clocks: clocks };
      }
      return null;
    });
  }
  function subscribe(setState) {
    if (!sb) return;
    unsubscribe();
    channel = sb.channel('crm-' + clientId).on('postgres_changes', { event: '*', schema: 'public' }, function (p) {
      try {
        if (p.eventType === 'DELETE') { if (p.old && p.old.id) applyRemote(setState, p.table, p.old.id, null); return; }
        var row = p.new;
        if (!row || !row.id || row.by === clientId) return;
        applyRemote(setState, p.table, row.id, row.data);
      } catch (e) { console.warn('[crm] live update skipped', e); }
    }).subscribe();
  }
  function unsubscribe() { if (channel && sb) { try { sb.removeChannel(channel); } catch (e) {} } channel = null; }

  // ---------- files ----------
  function keepBlob(id, file) { blobs[id] = file; }
  async function signUrls(jobs) {
    if (!sb) return false;
    var need = [];
    jobs.forEach(function (j) { (j.files || []).forEach(function (f) { if (f.path && !f.url && !(f.path in urlCache)) { urlCache[f.path] = ''; need.push(f.path); } }); });
    if (!need.length) return false;
    try {
      var data = ok(await sb.storage.from(BUCKET).createSignedUrls(need, 86400));
      (data || []).forEach(function (d) { if (d && d.path && d.signedUrl) urlCache[d.path] = d.signedUrl; });
    } catch (e) { need.forEach(function (p) { delete urlCache[p]; }); console.warn('[crm] could not open files', e); return false; }
    return true;
  }

  // ---------- painters ----------
  async function crewSnapshot() {
    var snap = ok(await sb.rpc('crew_snapshot'));
    if (!snap) return null;
    snap.jobs = (snap.jobs || []).map(function (j) {
      return Object.assign({ estimate: 0, estHours: 0, materials: [], expenses: [] }, j, {
        specs: j.specs || [], log: j.log || [], files: j.files || [], notes: j.notes || '',
        status: j.status || 0
      });
    });
    snap.workers = (snap.workers || []).map(function (w) { return Object.assign({}, w, { off: w.off || [] }); });
    return snap;
  }
  async function workerLogHours(jobId, worker, date, hours) {
    return ok(await sb.rpc('worker_job_update', { jid: jobId, kind: 'hours', payload: { worker: worker, date: date, hours: hours } }));
  }
  async function uploadMetas(jobId, metas) {
    var out = [];
    for (var i = 0; i < metas.length; i++) {
      var f = metas[i];
      if (!blobs[f.id]) continue;
      var path = await upload(jobId, f);
      var m = Object.assign({}, f, { path: path }); delete m.url;
      out.push(m);
    }
    return out;
  }
  async function workerAddFiles(jobId, metas) {
    var files = await uploadMetas(jobId, metas);
    if (!files.length) return;
    return ok(await sb.rpc('worker_job_update', { jid: jobId, kind: 'files', payload: { files: files } }));
  }
  async function workerAddReceipt(jobId, label, amount, photo) {
    var files = photo ? await uploadMetas(jobId, [photo]) : [];
    return ok(await sb.rpc('worker_job_update', { jid: jobId, kind: 'receipt', payload: { label: label, amount: amount, file: files[0] || null } }));
  }
  async function setClock(workerId, data) {
    if (data) return ok(await sb.from('clocks').upsert({ id: workerId, data: data, by: clientId, updated_at: new Date().toISOString() }));
    return ok(await sb.from('clocks').delete().eq('id', workerId));
  }

  // ---------- installable app ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  window.CRMBackend = {
    demo: demo, configured: configured, live: !!sb,
    init: init, onAuth: onAuth, signIn: signIn, signUp: signUp, signOut: signOut,
    resetPassword: resetPassword, setPassword: setPassword, claim: claim,
    loadAll: loadAll, push: push, subscribe: subscribe, unsubscribe: unsubscribe,
    keepBlob: keepBlob, signUrls: signUrls, withUrls: withUrls,
    crewSnapshot: crewSnapshot, workerLogHours: workerLogHours, workerAddFiles: workerAddFiles,
    workerAddReceipt: workerAddReceipt, setClock: setClock
  };
})();
