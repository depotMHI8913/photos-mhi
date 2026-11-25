/* Dépôt de photos MHI : file d'attente et envoi, partagés par la page et le service worker.
   - chaque photo part dès qu'elle est choisie (« pre ») ;
   - « Envoyer » transmet ensuite seulement la plaque et les coordonnées (« commit »), une petite requête « keepalive »
     qui arrive même si la page est fermée tout de suite ;
   - ce qui reste (pas de réseau, page fermée trop tôt) est repris par le service worker, et par la page à sa prochaine ouverture. */
'use strict';
const MHIQ = (() => {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => { const o = indexedDB.open('mhi-depot', 1); o.onupgradeneeded = () => o.result.createObjectStore('q', { keyPath: 'id' }); o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error); }));
  const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('q', mode); const s = t.objectStore('q'); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };
  const all = () => tx('readonly', (s) => s.getAll());
  const get = (id) => tx('readonly', (s) => s.get(id));
  const put = (o) => tx('readwrite', (s) => s.put(o));
  const del = (id) => tx('readwrite', (s) => s.delete(id));
  const relayUrl = (r) => (/^https:\/\//.test(r) ? r : 'https://script.google.com/macros/s/' + r + '/exec');
  const chan = typeof BroadcastChannel === 'function' ? new BroadcastChannel('mhi-depot') : null;
  const tell = () => { try { chan && chan.postMessage('maj'); } catch (e) { /* */ } };
  async function b64(blob) { const u = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
  async function post(r, body, keepalive) {
    const res = await fetch(relayUrl(r), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), keepalive: !!keepalive });
    return res.json();
  }
  let legacy = false;   // relais pas encore mis à jour : envoi complet en une fois, comme avant
  const ident = (it) => ({ plate: it.plate, note: it.note, who: it.who, prenom: it.prenom, nom: it.nom, mail: it.mail });
  /* « Envoyer » : plaque et coordonnées pour toutes les photos déjà arrivées du même envoi */
  async function commit(batch, keepalive) {
    const L = (await all()).filter((x) => x.batch === batch && x.state === 'wait' && x.uploaded && !x.committed); if (!L.length) return 0;
    const f = L[0]; const items = L.map((x) => ({ id: x.id, ts: x.ts, mime: x.mime, tsSrc: x.tsSrc, cam: x.cam, lat: x.lat, lon: x.lon, acc: x.acc, name: x.name, h0: x.h0, sz0: x.sz0 }));
    const r = await post(f.r, Object.assign({ a: 'commit', k: f.k, items }, ident(f)), keepalive);
    if (!r || !r.ok) { const err = (r && r.err) || 'refusé'; for (const x of L) { x.state = 'bad'; x.err = err; await put(x); } tell(); return 0; }
    const done = new Set(r.done || []); const missing = new Set(r.missing || []);
    for (const x of L) { const y = await get(x.id); if (!y) continue; if (done.has(x.id)) { y.committed = true; y.state = 'ok'; y.done = Date.now(); delete y.blob; y.err = ''; } else if (missing.has(x.id)) { y.uploaded = false; } await put(y); }
    tell(); return done.size;
  }
  async function upOne(it) {
    if (legacy) {   // ancien relais : tout en une fois (seulement après « Envoyer »)
      if (it.state !== 'wait') return true;
      const r = await post(it.r, Object.assign({ a: 'up', k: it.k, id: it.id, name: it.name, mime: it.mime, b64: await b64(it.blob), ts: it.ts, tsSrc: it.tsSrc, cam: it.cam, lat: it.lat, lon: it.lon, acc: it.acc, h0: it.h0, sz0: it.sz0, h1: it.h1 }, ident(it)));
      const y = await get(it.id); if (!y) return true;
      if (r.ok) { y.state = 'ok'; y.committed = y.uploaded = true; y.done = Date.now(); delete y.blob; y.err = ''; } else { y.state = 'bad'; y.err = r.err || 'refusé'; }
      await put(y); tell(); return true;
    }
    const fin = it.state === 'wait';   // « Envoyer » déjà touché : la plaque part avec la photo, un seul appel
    const body = Object.assign({ a: 'pre', k: it.k, id: it.id, mime: it.mime, ts: it.ts, h1: it.h1 }, fin ? Object.assign({ final: true, tsSrc: it.tsSrc, cam: it.cam, lat: it.lat, lon: it.lon, acc: it.acc, name: it.name, h0: it.h0, sz0: it.sz0 }, ident(it)) : {});
    body.b64 = await b64(it.blob);
    const r = await post(it.r, body);
    if (!r.ok && /administrateur/i.test(r.err || '')) { legacy = true; return upOne(it); }
    const y = await get(it.id); if (!y) return true;   // annulée entre-temps
    if (r.ok) { y.uploaded = true; y.recu = r.recu || Date.now(); y.err = ''; if (r.done) { y.committed = true; y.state = 'ok'; y.done = Date.now(); delete y.blob; } } else { y.state = 'bad'; y.err = r.err || 'refusé'; }
    await put(y); tell(); return true;
  }
  let running = false;
  async function run() {
    if (running) return; running = true;
    try {
      for (let round = 0; round < 4; round++) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
        const L = (await all()).filter((x) => x.blob && !x.uploaded && (x.state === 'draft' || x.state === 'wait')).sort((a, b) => (a.state === 'wait' ? 0 : 1) - (b.state === 'wait' ? 0 : 1) || a.added - b.added);
        let stop = false;
        const work = async () => { while (L.length && !stop) { const it = L.shift(); try { await upOne(it); } catch (e) { stop = true; const y = await get(it.id); if (y) { y.err = 'Envoi interrompu, nouvel essai bientôt'; await put(y); tell(); } } } };
        await Promise.all([work(), work(), work()]);   // 3 photos en parallèle
        const batches = [...new Set((await all()).filter((x) => x.state === 'wait' && x.uploaded && !x.committed).map((x) => x.batch))];
        for (const bt of batches) { try { await commit(bt, true); } catch (e) { stop = true; } }
        const left = (await all()).filter((x) => (x.state === 'wait' && !x.committed) || (x.state === 'draft' && !x.uploaded && x.blob));
        if (!left.length || stop) break;
      }
      const lim = Date.now() - 7 * 864e5; for (const x of await all()) if (x.state === 'ok' && x.done < lim) await del(x.id);   // historique : 7 jours
    } finally { running = false; }
  }
  /* un seul envoi à la fois entre la page et le service worker */
  /* page : n'attend pas si le service worker envoie déjà ; service worker : attend que la page ait fini (ou ait été fermée) puis reprend la suite */
  function flush(wait) { if (typeof navigator !== 'undefined' && navigator.locks) return wait ? navigator.locks.request('mhi-envoi', () => run()) : navigator.locks.request('mhi-envoi', { ifAvailable: true }, (l) => (l ? run() : null)); return run(); }
  const pendingCount = async () => (await all()).filter((x) => x.state === 'wait').length;
  return { all, get, put, del, post, commit, flush, pendingCount, relayUrl, chan, tell };
})();
