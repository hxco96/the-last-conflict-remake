// Round cycle: lobby (intermission timer) -> match -> results -> lobby …
// * The lobby is always alive (Base map). During intermission the host picks — or players
//   vote on — the next map, mode, theme and difficulty.
// * When the timer ends the match starts only if at least one player joined the round.
//   Joined players either deploy straight away, or stay in the lobby to shop / spectate and
//   walk out through a DEPLOY door whenever they like.
// * When the match ends (everyone deployed is dead, objective won, or nobody ever deployed)
//   coins are paid out from kills, time alive and difficulty, and the next intermission starts.
// Online co-op (coop.js): the host runs the timer, tallies everyone's votes and starts/ends rounds;
// clients mirror the host's state. Solo play is the same flow with one voter.
import { Game } from './game.js';
import { MODES, THEMES } from './modes.js';
import { DIFFICULTY, ZOMBIE_COUNT, payout } from './profile.js';
import { music } from './sfx.js';
import { CAUSES } from './survival.js';

export const FIRST_INTERMISSION = 60;
export const INTERMISSION = 45;
const ABANDON_AFTER = 150; // a started match with nobody deployed ends after this long


export class Session {
  constructor({ canvas, assets, data, input, profile, cls, look, ui, coop = null }) {
    Object.assign(this, { canvas, assets, data, input, profile, cls, look, ui, coop });
    this.votes = new Map();        // co-op host: player id -> { cat: value }
    this.joinedPeers = new Set();  // co-op host: clients queued for the next round
    this.stateT = 0;
    this.state = 'intermission';
    this.timer = FIRST_INTERMISSION;
    const mi = assets.mapIndex.findIndex((m) => m.name !== 'Base');
    this.next = { map: Math.max(0, mi), mode: 'Survival', theme: 'Zeds', difficulty: 'Normal', density: 'Normal' };
    this.hostMode = true;          // host picks; false = vote
    this.ballot = this.makeBallot();
    this.myVote = {};
    this.joined = false;
    this.autoDeploy = true;
    this.autoStart = true;         // host option: rounds start (and drop everyone in) on their own
    this.force = false;            // host pressed Start with auto-start off
    this.match = null;
    this.view = 'lobby';           // 'lobby' | 'spectate' | 'match'
    this.round = 0;
    this.notice = '';
  }

  async init() {
    const base = this.assets.mapIndex.find((m) => m.name === 'Base') || this.assets.mapIndex[0];
    // only expose the lobby to the frame loop once it has fully loaded
    const lobby = new Game(this.canvas, this.assets, this.data, {
      map: base, cls: this.cls, look: this.look, input: this.input, mode: 'Peaceful', lobby: true, profile: this.profile, coop: this.coop,
    });
    lobby.session = this;
    await lobby.start();
    this.lobby = lobby;
    this.lobby.onMerchant = () => this.ui.merchant();
    this.lobby.onBoard = () => this.ui.board();
    this.lobby.onStorage = () => this.ui.storage();
    this.lobby.onArmory = (c) => this.ui.armory(c);
    this.lobby.onDeploy = () => this.deploy();
    this.lobby.msg('Welcome to the base. Gear up at the ARMORY tables, upgrade with the merchant, vote at the mission board.', '#9cd4ff');
    music(this.lobbyTrack());
    if (this.coop) {
      this.coop.session = this;
      if (this.coop.client) this.coop.hello();
      this.lobby.msg(this.coop.host ? `Co-op room ${this.coop.code} is open — friends join with this code (up to 4 players).` : `Joined co-op room ${this.coop.code}. The host runs the rounds; vote at the mission board.`, '#ffd36b');
    }
  }

  get active() { return this.view === 'lobby' ? this.lobby : this.match || this.lobby; }
  matchRunning() { return this.state === 'running' && !!this.match; }

  // ---------- host / vote ----------
  // Voting offers exactly the same choices as a host pick.
  makeBallot() {
    const maps = this.assets.mapIndex.map((m, i) => i).filter((i) => this.assets.mapIndex[i].name !== 'Base');
    return { map: maps, mode: Object.keys(MODES).filter((k) => !(MODES[k].solo && this.coop)), theme: Object.keys(THEMES), difficulty: Object.keys(DIFFICULTY), density: Object.keys(ZOMBIE_COUNT) };
  }
  vote(cat, value) {
    this.myVote[cat] = value;
    if (this.coop && this.coop.client) { this.coop.net.toHost({ t: 'vote', cat, value }); return; }
    this.votes.set('H', { ...this.myVote });
    this.recount(cat);
  }
  remoteVote(id, cat, value) {
    const v = this.votes.get(id) || {};
    v[cat] = value;
    this.votes.set(id, v);
    if (!this.hostMode) this.recount(cat);
    this.broadcastState();
  }
  // most votes wins; ties go to the host's pick
  recount(cat) {
    const counts = new Map();
    for (const v of this.votes.values()) if (v[cat] != null) counts.set(v[cat], (counts.get(v[cat]) || 0) + 1);
    let best = null, bc = 0;
    for (const [k, c] of counts) if (c > bc || (c === bc && this.myVote[cat] === k)) { best = k; bc = c; }
    if (best != null) this.next[cat] = best;
  }
  tally(cat, value) {
    if (this.coop && this.coop.client) return (this.tallies && this.tallies[cat] && this.tallies[cat][value]) || 0;
    if (!this.coop) return this.myVote[cat] === value ? 1 : 0;
    let n = 0;
    for (const v of this.votes.values()) if (v[cat] === value) n++;
    return n;
  }
  join(auto = true) { this.joined = true; this.autoDeploy = auto; if (this.coop && this.coop.client) this.coop.net.toHost({ t: 'join', on: true }); }
  leaveQueue() { this.joined = false; if (this.coop && this.coop.client) this.coop.net.toHost({ t: 'join', on: false }); }
  remoteJoin(id, on) { if (on) this.joinedPeers.add(id); else this.joinedPeers.delete(id); this.broadcastState(); }
  startSoon() {
    if (this.coop && this.coop.client) { this.coop.net.toHost({ t: 'soon' }); return; }
    if (this.state === 'intermission') this.timer = Math.min(this.timer, 3);
  }
  // host with auto-start off: launch the round now, taking everyone who is in the room
  hostGo() {
    if (this.state !== 'intermission' || (this.coop && this.coop.client)) return;
    this.force = true; this.joined = true; this.dropAll = true; this.timer = 0;
  }
  setAutoStart(on) { this.autoStart = on; this.force = false; if (on && this.timer <= 0) this.timer = 3; this.broadcastState(); }
  get anyoneJoined() { return this.autoStart || this.joined || this.joinedPeers.size > 0; }
  // in the lobby with a match running (or about to): you're dropped in without queuing
  get dropIn() { return this.autoStart || this.joined || this.dropAll; }

  // ---------- co-op state sync ----------
  broadcastState() {
    if (!this.coop || !this.coop.host) return;
    const tallies = {};
    for (const v of this.votes.values()) for (const [cat, val] of Object.entries(v)) { tallies[cat] = tallies[cat] || {}; tallies[cat][val] = (tallies[cat][val] || 0) + 1; }
    this.coop.net.broadcast({ t: 'ss', state: this.state, timer: this.timer, next: this.next, round: this.round, ballot: this.ballot, hostMode: this.hostMode, tallies, joined: this.joinedPeers.size + (this.joined ? 1 : 0), auto: this.autoStart });
  }
  applyState(m) {
    this.timer = m.timer; this.next = m.next; this.ballot = m.ballot; this.hostMode = m.hostMode; this.tallies = m.tallies; this.joinedCount = m.joined; if (m.auto !== undefined) this.autoStart = m.auto;
    this.hostState = m.state; // the client's own state follows the host's start/end messages
  }

  // ---------- cycle ----------
  update(dt) {
    if (this.coop) {
      this.coop.update(dt);
      this.stateT -= dt;
      if (this.stateT <= 0) { this.stateT = 0.5; this.broadcastState(); }
    }
    const client = this.coop && this.coop.client;
    if (this.state === 'intermission' && client) this.timer = Math.max(0, this.timer - dt); // the host starts rounds
    else if (this.state === 'intermission') {
      this.timer -= dt;
      if (this.timer <= 0 && !this.autoStart && !this.force) this.timer = 0; // host-run: hold until Start
      else if (this.timer <= 0) {
        this.force = false;
        if (this.anyoneJoined) this.startMatch();
        else {
          this.timer = INTERMISSION;
          this.lobby.msg('Nobody joined — round skipped. Use the mission board to join the next one.', '#ffb0b0');
          this.ballot = this.makeBallot(); this.myVote = {}; this.votes.clear();
        }
      }
    }
    // the lobby keeps running while you're in it; the match runs whenever it exists
    if (this.view === 'lobby') this.lobby.update(dt);
    if (this.match && !this.starting) {
      this.match.update(dt);
      const m = this.match;
      if (!this.coop) {
        if (m.over) this.endMatch(m.won ? 'won' : 'died');
        else if (m.ghost && !m.deployedAt && m.time > ABANDON_AFTER) this.endMatch('abandoned');
      } else this.coopMatchRules(m, dt);
    }
  }

  // Co-op: your own death ends YOUR run (results + back to base) while the round goes on for the
  // others; the host ends the round when the objective is done or nobody is left standing.
  coopMatchRules(m, dt) {
    const C = this.coop;
    if (C.client) {
      if (m.over && !m.out) this.personalEnd('died');
      return;
    }
    if (m.won) { C.net.broadcast({ t: 'end', won: m.won, round: this.round }); this.endMatch('won'); return; }
    if (m.over && !m.out) this.personalEnd('died');
    const remote = C.anyRemoteInMatch();
    if (remote) m.everDeployed = true;
    const meUp = !m.ghost && m.player.alive;
    if (meUp || m.deployedAt) m.everDeployed = true;
    m.emptyT = meUp || remote ? 0 : (m.emptyT || 0) + dt;
    if (m.everDeployed && m.emptyT > 3) { C.net.broadcast({ t: 'end', round: this.round }); this.endMatch('died'); }
    else if (!m.everDeployed && m.time > ABANDON_AFTER) { C.net.broadcast({ t: 'end', round: this.round }); this.endMatch('abandoned'); }
  }

  // co-op client: the host ended the round
  hostEnded(msg) {
    const m = this.match;
    if (!m || msg.round !== this.round) return;
    if (m.out || m.ghost) { this.endMatch('abandoned', true); return; }
    if (msg.won && m.player.alive) { m.won = msg.won; this.endMatch('won'); }
    else this.endMatch('died');
  }

  // co-op: pay out and send this player back to base; the match keeps running
  personalEnd(result) {
    const m = this.match;
    this.payout(m, result);
    m.out = true; m.over = false; m.ghost = true; m.player.alive = true; m.player.down = false;
    this.view = 'lobby';
    const lb = this.lobby;
    lb.ammo.slots.length = 0; lb.throwables.counts.clear(); lb.throwables.sel = null; lb.items.clear();
    lb.applyLoadout(lb.classLoadout());
    music(this.lobbyTrack());
    this.ui.results({ record: m.record, result, deployed: true, pay: m.lastPay, kills: m.kills, alive: m.aliveTime || 0, map: m.opts.map.name, mode: m.opts.mode, difficulty: m.opts.difficulty, wonText: null, coop: true });
  }

  payout(m, result) {
    const pay = payout({ kills: m.kills, alive: m.aliveTime || 0, won: result === 'won', difficulty: m.opts.difficulty });
    // everything you carried or picked up stays in your inventory (even if you died)
    const kept = m.slots.filter(Boolean).map((s) => s.item.name);
    this.profile.inventory = kept.length ? kept : ['Beretta92'];
    this.profile.coins += pay.total + (m.reviveBonus || 0);
    this.profile.stats.matches++;
    this.profile.stats.kills += m.kills;
    this.profile.stats.best = Math.max(this.profile.stats.best, Math.round(m.aliveTime || 0));
    m.record = this.record(m, result);
    this.profile.save();
    m.lastPay = pay;
    return pay;
  }

  // Personal bests per map · mode · difficulty, plus overall hordes / threat records.
  record(m, result) {
    const st = this.profile.stats, time = Math.round(m.aliveTime || 0);
    const key = `${m.opts.map.name} · ${m.opts.mode} · ${m.opts.difficulty}`;
    st.records = st.records || {};
    const prev = st.records[key] || null;
    const hordes = m.dir ? m.dir.hordes : 0, threat = m.dir ? m.dir.threat : 1;
    const newRecord = time > 20 && (!prev || time > prev.time);
    if (newRecord) st.records[key] = { time, kills: m.kills, hordes, threat };
    st.hordes = Math.max(st.hordes || 0, hordes);
    st.threat = Math.max(st.threat || 0, threat);
    return { key, prev, newRecord, time, hordes, threat, cause: result === 'died' ? (CAUSES[m.lastHurt] || 'overwhelmed') : null };
  }

  render() {
    const g = this.active;
    if (g && g.map) g.render();
  }

  async startMatch(msg = null) {
    if (this.starting) return;
    this.state = 'starting';
    this.starting = true;
    if (msg) { this.round = msg.round; this.next = msg.next; } // co-op client: the host's pick
    else this.round++;
    this.lobby.ext.syncInv();
    const L = this.lobby.loadoutSnapshot();
    const n = this.next;
    this.lobby.msg(`Round ${this.round}: ${this.assets.mapIndex[n.map].name} · ${n.mode} · ${n.theme} · ${n.difficulty} · ${n.density || 'Normal'} zeds`, '#ffd36b');
    const m = new Game(this.canvas, this.assets, this.data, {
      map: this.assets.mapIndex[n.map], cls: this.cls, look: this.look, input: this.input, mode: n.mode, theme: n.theme,
      difficulty: n.difficulty, density: n.density || 'Normal', profile: this.profile, loadout: L, spectate: true, coop: this.coop,
    });
    m.netNext = { ...n };
    m.onEnd = () => {}; m.onWin = () => {};
    try { await m.start(); } catch (err) { this.starting = false; this.state = 'intermission'; this.timer = INTERMISSION; throw err; }
    m.session = this;
    // co-op: everyone starts together at a spot the host picks
    if (this.coop && this.coop.host) { m.teamSpawn = m.pickSpawn(); this.coop.net.broadcast({ t: 'start', round: this.round, next: { ...n }, spawn: m.teamSpawn, all: this.autoStart || this.dropAll }); }
    else if (msg && msg.spawn) { m.teamSpawn = msg.spawn; this.dropAll = !!msg.all; }
    this.match = m;
    this.starting = false;
    this.state = 'running';
    const drop = this.dropIn && this.autoDeploy && this.view === 'lobby';
    this.dropAll = false;
    if (drop) this.deploy();
    else this.lobby.msg('Match started without you — walk out a DEPLOY door to join, or spectate from the mission board.', '#7dff8a');
  }

  deploy() {
    if (!this.matchRunning()) return;
    if (this.match.out) { this.lobby.msg('You are out for this round — spectate from the mission board, or wait for the next one.', '#ffb0b0'); return; }
    this.lobby.ext.syncInv();
    const L = this.lobby.loadoutSnapshot();
    this.match.deploy(L);
    this.view = 'match';
    this.input.prev = new Map(this.input.down);
    music('playlist');
  }

  spectate(on = true) {
    if (!this.matchRunning() || !this.match.ghost) return;
    this.view = on ? 'spectate' : 'lobby';
  }

  // Leave a running match back to the lobby (counts as the end of your run).
  retreat() {
    if (!this.match || this.match.ghost) return;
    if (this.coop) this.personalEnd('retreated');
    else this.endMatch('retreated');
  }

  endMatch(result, quiet = false) {
    const m = this.match;
    if (!m) return;
    const deployed = !m.out && (!!m.deployedAt || !m.ghost);
    const pay = deployed ? this.payout(m, result) : null;
    if (m.ext) m.ext.stop();
    const summary = { record: m.record, result, deployed, pay, kills: m.kills, alive: m.aliveTime || 0, map: m.opts.map.name, mode: m.opts.mode, difficulty: m.opts.difficulty, wonText: m.won };
    this.match = null;
    this.state = 'intermission';
    this.timer = INTERMISSION;
    this.view = 'lobby';
    this.joined = false;
    this.ballot = this.makeBallot();
    this.myVote = {};
    this.votes.clear();
    this.joinedPeers.clear();
    // back in the lobby with the weapons you kept; ammo and throwables reset
    const lb = this.lobby;
    lb.ammo.slots.length = 0; lb.throwables.counts.clear(); lb.throwables.sel = null; lb.items.clear();
    lb.applyLoadout(lb.classLoadout());
    music(this.lobbyTrack());
    if (quiet) return;
    if (summary.deployed) this.ui.results(summary);
    else if (result === 'abandoned') lb.msg('The round ended — nobody deployed.', '#ffb0b0');
  }

  // Base music: the Tethered mix of Sake by default, the original if picked in Settings.
  lobbyTrack() { return this.input && this.input.settings.lobbyMusic === 'original' ? 'Sake' : 'Sake (Tethered)'; }

  // What the base's next-round card shows (see LobbyExt.drawCard).
  lobbyInfo() {
    const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const rules = (o) => [o.mode, o.difficulty, o.mode === 'Peaceful' ? null : `${o.density || 'Normal'} zeds`].filter(Boolean).join(' · ');
    const room = this.coop ? `ROOM ${this.coop.code} ${this.coop.count}/4 · ` : '';
    if (this.state === 'running' && this.match) {
      const o = this.match.opts;
      return { label: `ROUND ${this.round} LIVE`, clock: clock(this.match.time || 0), map: o.map.name, line: room + rules(o), status: this.dropIn && this.autoDeploy ? 'IN PROGRESS — dropping you in' : 'IN PROGRESS — walk out a green DEPLOY door', color: '#7dff8a' };
    }
    const n = this.next, name = this.assets.mapIndex[n.map].name;
    if (this.state === 'starting') return { label: 'STARTING', clock: '…', map: name, line: room + rules(n), status: 'DEPLOYING…', color: '#ffd36b' };
    const t = Math.max(0, Math.ceil(this.timer));
    const others = this.coop ? (this.coop.host ? this.joinedPeers.size : Math.max(0, (this.joinedCount || 0) - (this.joined ? 1 : 0))) : 0;
    const team = others ? ` · ${others} teammate${others > 1 ? 's' : ''} in` : '';
    if (!this.autoStart) return { label: 'HOST-RUN', clock: '--:--', map: name, line: room + rules(n), status: 'WAITING FOR THE HOST TO START — gear up', color: '#ffb347' };
    const status = this.autoStart ? `AUTO-START ✓ — you drop in automatically${team}` : this.joined ? (this.autoDeploy ? `JOINED ✓ — deploying at the start${team}` : `JOINED ✓ — walk out a DEPLOY door${team}`) : `NOT JOINED — open the mission board${team}`;
    return { label: 'NEXT ROUND', clock: clock(t), urgent: t <= 10, map: name, line: room + rules(n), status, color: this.dropIn ? '#7dff8a' : '#ffb347' };
  }
}
