// MARKET: a player market shared by every server and every player, online or not.
// Sellers post gun mods and spare weapons from their locker; buyers pay from a market wallet that
// lives on the server (Supabase). Items reach the buyer as deliveries the next time they open the
// market. Every trade runs through database functions that check balances and ownership in one
// transaction, so the game client never edits the wallet or listings directly.
// Coins move between the game and the market wallet with a daily deposit cap (the browser is not
// trusted), a 5% listing fee and a 5% sales tax keep the economy from inflating.
import { modName, modColor, parseMod } from './mods.js';

const URL_ = 'https://wzalddznikqhfxgtemkx.supabase.co';
const KEY = 'sb_publishable_zP_P3VajrkGcCNjzCXoDNQ_5MLU9Cff'; // publishable key: safe in the client
const AUTH = 'deadline-auth-v1';

// ---------- auth (anonymous account, upgradable to email later) ----------
let session = null;
function loadSession() { try { session = JSON.parse(localStorage.getItem(AUTH) || 'null'); } catch { session = null; } }
function saveSession(s) { session = s; try { localStorage.setItem(AUTH, JSON.stringify(s)); } catch { /* no storage */ } }

async function authCall(path, body) {
  const r = await fetch(`${URL_}/auth/v1/${path}`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.msg || j.error_description || j.message || `sign-in failed (${r.status})`);
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: j.user && j.user.id };
}

export async function signIn() {
  loadSession();
  const now = Math.floor(Date.now() / 1000);
  if (session && session.expires_at - 60 > now) return session;
  if (session && session.refresh_token) {
    try { saveSession(await authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token })); return session; } catch { /* fall through to a new account */ }
  }
  saveSession(await authCall('signup', { data: {} }));
  return session;
}

async function api(method, path, body) {
  const s = await signIn();
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method, headers: { apikey: KEY, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && (j.message || j.hint)) || `market error ${r.status}`);
  return j;
}
const rpc = (fn, args = {}) => api('POST', `rpc/${fn}`, args);

export const market = {
  join: (name) => rpc('market_join', { p_name: name }),
  me: async () => (await api('GET', 'players?select=*'))[0] || null,
  browse: () => api('GET', 'listings?select=*&status=eq.open&order=created_at.desc&limit=80'),
  mine: () => api('GET', `listings?select=*&seller=eq.${session.user}&status=eq.open&order=created_at.desc`),
  list: (kind, item, price) => rpc('market_list', { p_kind: kind, p_item: item, p_price: price }),
  buy: (id) => rpc('market_buy', { p_listing: id }),
  cancel: (id) => rpc('market_cancel', { p_listing: id }),
  claim: () => rpc('market_claim'),
  deposit: (n) => rpc('market_deposit', { p_amount: n }),
  withdraw: (n) => rpc('market_withdraw', { p_amount: n }),
};

// put delivered items into the local profile
function receive(profile, rows) {
  const got = [];
  for (const d of rows || []) {
    if (d.item_kind === 'mod' && parseMod(d.item_id)) { profile.modBag[d.item_id] = (profile.modBag[d.item_id] || 0) + 1; got.push(modName(d.item_id)); }
    else if (d.item_kind === 'weapon') { profile.storage.push(d.item_id); got.push(d.item_id); }
  }
  if (got.length) profile.save();
  return got;
}

// ---------- the market screen ----------
export function openMarket(game, onClose) {
  const prof = game && game.profile;
  if (!prof) return;
  prof.modBag = prof.modBag || {};
  const root = document.createElement('div');
  root.dataset.market = '1';
  root.setAttribute('style', 'position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;font-family:Bebas,Impact,sans-serif;color:#e8e8e8;padding:12px;box-sizing:border-box');
  document.body.append(root);
  const wasPaused = game.paused;
  if (!game.coop) game.paused = true;
  const key = (e) => { if (e.key === 'Escape' || e.key === 'k' || e.key === 'K') { e.stopPropagation(); e.preventDefault(); close(); } };
  window.addEventListener('keydown', key, true);
  function close() { root.remove(); window.removeEventListener('keydown', key, true); game.paused = wasPaused; prof.save(); onClose && onClose(); }

  const mk = (tag, st, txt) => { const e = document.createElement(tag); if (st) e.setAttribute('style', st); if (txt != null) e.textContent = txt; return e; };
  const btn = (label, fn, ok = true, col = '#ffd36b') => { const b = mk('button', `font:inherit;font-size:16px;letter-spacing:1px;padding:5px 12px;border:1px solid ${ok ? col : '#444'};background:${ok ? '#1e1c12' : '#16181c'};color:${ok ? col : '#777'};cursor:pointer;min-height:34px`, label); b.onclick = ok ? fn : null; return b; };
  const sm = 'font-family:system-ui,sans-serif;font-size:12px;';
  const itemLabel = (l) => (l.item_kind === 'mod' ? modName(l.item_id) : l.item_id);
  const itemCol = (l) => (l.item_kind === 'mod' ? modColor(l.item_id) : '#e8e8e8');

  let tab = 'browse', me = null, listings = [], mine = [], note = '', busy = false;
  const panel = mk('div', 'background:#0c0e12;border:1px solid #ffd36b;max-width:700px;width:100%;max-height:92vh;overflow:auto;padding:16px 18px;box-sizing:border-box');
  root.append(panel);

  async function act(fn, ok) {
    if (busy) return;
    busy = true; note = 'Working…'; render();
    try { await fn(); note = ok || ''; } catch (e) { note = '⚠ ' + e.message; }
    busy = false;
    await refresh(false);
  }

  async function refresh(first) {
    try {
      if (first) {
        await signIn();
        me = await market.me();
        if (!me) me = await market.join((prof.prefs && prof.prefs.name) || 'Survivor');
        const got = receive(prof, await market.claim());
        if (got.length) note = `Delivered: ${got.join(', ')}`;
      } else me = await market.me();
      [listings, mine] = await Promise.all([market.browse(), market.mine()]);
    } catch (e) { note = '⚠ ' + e.message; }
    render();
  }

  function render() {
    panel.replaceChildren();
    panel.append(mk('div', 'font-size:30px;color:#ffd36b;letter-spacing:2px', 'MARKET'));
    panel.append(mk('div', sm + 'color:#9aa', 'One market for every server. Listings stay up while you are offline; sales are paid into your market wallet.'));
    const top = mk('div', 'display:flex;gap:14px;flex-wrap:wrap;font-size:19px;margin:8px 0');
    top.append(mk('div', 'color:#9cd4ff', `Market wallet ${me ? me.coins : '…'} C`), mk('div', 'color:#c8a45a', `In game ${prof.coins} C`));
    panel.append(top);
    const tabs = mk('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px');
    for (const [id, name] of [['browse', 'Browse'], ['sell', 'Sell'], ['wallet', 'Wallet'], ['mine', `My listings (${mine.length})`]]) tabs.append(btn(name, () => { tab = id; render(); }, true, tab === id ? '#ffd36b' : '#8892a0'));
    panel.append(tabs);
    if (note) panel.append(mk('div', sm + `color:${note.startsWith('⚠') ? '#ff8b8b' : '#7dff8a'};margin:4px 0 8px`, note));
    const row = (l, right) => {
      const r = mk('div', 'display:flex;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid #1d2026');
      const info = mk('div', 'flex:1;min-width:0');
      info.append(mk('div', `font-size:18px;color:${itemCol(l)}`, itemLabel(l)));
      info.append(mk('div', sm + 'color:#889', `${l.item_kind} · by ${l.seller_name}`));
      r.append(info, mk('div', 'font-size:19px;color:#ffd36b;min-width:70px;text-align:right', `${l.price} C`), right);
      return r;
    };
    if (tab === 'browse') {
      const others = listings.filter((l) => l.seller !== (session && session.user));
      if (!others.length) panel.append(mk('div', sm + 'color:#9aa', 'Nothing for sale right now. Be the first: list a spare mod or weapon.'));
      for (const l of others) panel.append(row(l, btn('Buy', () => act(async () => { await market.buy(l.id); receive(prof, await market.claim()); }, `Bought ${itemLabel(l)}`), !busy && me && me.coins >= l.price)));
    } else if (tab === 'mine') {
      if (!mine.length) panel.append(mk('div', sm + 'color:#9aa', 'You have nothing listed.'));
      for (const l of mine) panel.append(row(l, btn('Take down', () => act(async () => { await market.cancel(l.id); receive(prof, await market.claim()); }, 'Listing taken down; the item is back in your bag'), !busy, '#ff9b8b')));
    } else if (tab === 'sell') {
      panel.append(mk('div', sm + 'color:#9aa;margin-bottom:6px', 'Listing fee 5% of the price (paid now from the market wallet). Buyers pay a 5% tax: you receive 95%.'));
      const price = mk('input', 'font:inherit;font-size:18px;width:110px;background:#0d0f13;color:#ffd36b;border:1px solid #333842;padding:4px 8px');
      price.type = 'number'; price.min = 10; price.value = 100;
      const pr = mk('div', 'display:flex;gap:8px;align-items:center;margin-bottom:8px'); pr.append(mk('div', 'font-size:18px', 'Price'), price, mk('div', sm + 'color:#889', 'coins'));
      panel.append(pr);
      const sell = (kind, id, take) => act(async () => {
        const p = Math.round(+price.value);
        await market.list(kind, id, p);
        take();
        prof.save();
      }, `Listed for ${Math.round(+price.value)} C`);
      const mods = Object.entries(prof.modBag).filter(([, n]) => n > 0);
      panel.append(mk('div', 'font-size:20px;color:#9cd4ff;margin-top:6px', 'Mods in your bag'));
      if (!mods.length) panel.append(mk('div', sm + 'color:#9aa', 'No spare mods.'));
      const wrap = mk('div', 'display:flex;gap:6px;flex-wrap:wrap');
      for (const [id, n] of mods) wrap.append(btn(`${modName(id)} ×${n}`, () => sell('mod', id, () => { prof.modBag[id]--; if (!prof.modBag[id]) delete prof.modBag[id]; }), !busy, modColor(id)));
      panel.append(wrap);
      panel.append(mk('div', 'font-size:20px;color:#9cd4ff;margin-top:10px', 'Weapons in your base locker'));
      const lock = prof.storage || [];
      if (!lock.length) panel.append(mk('div', sm + 'color:#9aa', 'Your locker is empty (store weapons at the base storage first).'));
      const w2 = mk('div', 'display:flex;gap:6px;flex-wrap:wrap');
      lock.forEach((name, i) => w2.append(btn(name, () => sell('weapon', name, () => { prof.storage.splice(prof.storage.indexOf(name), 1); }), !busy)));
      panel.append(w2);
    } else if (tab === 'wallet') {
      panel.append(mk('div', sm + 'color:#9aa;margin-bottom:6px', 'Move coins between the game and the market. Up to 3000 coins a day can go in; any amount can come out.'));
      const amt = mk('input', 'font:inherit;font-size:18px;width:110px;background:#0d0f13;color:#ffd36b;border:1px solid #333842;padding:4px 8px');
      amt.type = 'number'; amt.min = 1; amt.value = 100;
      const r = mk('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap');
      r.append(amt,
        btn('Deposit →', () => { const n = Math.round(+amt.value); if (n > prof.coins) { note = '⚠ not enough coins in the game'; return render(); } act(async () => { await market.deposit(n); prof.coins -= n; prof.save(); }, `Deposited ${Math.round(+amt.value)} C`); }, !busy),
        btn('← Withdraw', () => { const n = Math.round(+amt.value); act(async () => { await market.withdraw(n); prof.coins += n; prof.save(); }, `Withdrew ${n} C`); }, !busy));
      panel.append(r);
    }
    const foot = mk('div', 'margin-top:14px;display:flex;gap:8px');
    foot.append(btn('Refresh', () => refresh(false), !busy, '#9cd4ff'), btn('Close (K)', close));
    panel.append(foot);
  }
  render();
  refresh(true);
}
