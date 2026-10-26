// Round cycle: lobby (intermission timer) -> match -> results -> lobby …
// * The lobby is always alive (Base map). During intermission the host picks — or players
//   vote on — the next map, mode, theme and difficulty.
// * When the timer ends the match starts only if at least one player joined the round.
//   Joined players either deploy straight away, or stay in the lobby to shop / spectate and
//   walk out through a DEPLOY door whenever they like.
// * When the match ends (everyone deployed is dead, objective won, or nobody ever deployed)
//   coins are paid out from kills, time alive and difficulty, and the next intermission starts.
// Networking is not part of this build: "players" is the local player, so votes tally one voter.
import { Game } from './game.js';
import { MODES, THEMES } from './modes.js';
import { DIFFICULTY, payout } from './profile.js';
import { music } from './sfx.js';

export const FIRST_INTERMISSION = 60;
export const INTERMISSION = 45;
const ABANDON_AFTER = 150; // a started match with nobody deployed ends after this long

const pickN = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

export class Session {
  constructor({ canvas, assets, data, input, profile, cls, look, ui }) {
    Object.assign(this, { canvas, assets, data, input, profile, cls, look, ui });
    this.state = 'intermission';
    this.timer = FIRST_INTERMISSION;
    const mi = assets.mapIndex.findIndex((m) => m.name !== 'Base');
    this.next = { map: Math.max(0, mi), mode: 'Survival', theme: 'Zeds', difficulty: 'Normal' };
    this.hostMode = true;          // host picks; false = vote
    this.ballot = this.makeBallot();
    this.myVote = {};
    this.joined = false;
    this.autoDeploy = true;
    this.match = null;
    this.view = 'lobby';           // 'lobby' | 'spectate' | 'match'
    this.round = 0;
    this.notice = '';
  }

  async init() {
    const base = this.assets.mapIndex.find((m) => m.name === 'Base') || this.assets.mapIndex[0];
    // only expose the lobby to the frame loop once it has fully loaded
    const lobby = new Game(this.canvas, this.assets, this.data, {
      map: base, cls: this.cls, look: this.look, input: this.input, mode: 'Peaceful', lobby: true, profile: this.profile,
    });
    lobby.session = this;
    await lobby.start();
    this.lobby = lobby;
    this.lobby.onMerchant = () => this.ui.merchant();
    this.lobby.onBoard = () => this.ui.board();
    this.lobby.onStorage = () => this.ui.storage();
    this.lobby.onDeploy = () => this.deploy();
    this.lobby.msg('Welcome to the base. Gear up at the tables, upgrade with the merchant, vote at the mission board.', '#9cd4ff');
    music('Save Room(RE0)');
  }

  get active() { return this.view === 'lobby' ? this.lobby : this.match || this.lobby; }
  matchRunning() { return this.state === 'running' && !!this.match; }

  // ---------- host / vote ----------
  makeBallot() {
    const maps = this.assets.mapIndex.map((m, i) => i).filter((i) => this.assets.mapIndex[i].name !== 'Base');
    return {
      map: pickN(maps, 3),
      mode: pickN(Object.keys(MODES).filter((m) => m !== 'Peaceful'), 3),
      theme: pickN(Object.keys(THEMES), 3),
      difficulty: Object.keys(DIFFICULTY),
    };
  }
  vote(cat, value) {
    this.myVote[cat] = value;
    this.next[cat] = value; // one local voter: their vote carries
  }
  tally(cat, value) { return this.myVote[cat] === value ? 1 : 0; }
  join(auto = true) { this.joined = true; this.autoDeploy = auto; }
  leaveQueue() { this.joined = false; }
  startSoon() { if (this.state === 'intermission') this.timer = Math.min(this.timer, 3); }

  // ---------- cycle ----------
  update(dt) {
    if (this.state === 'intermission') {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.joined) this.startMatch();
        else {
          this.timer = INTERMISSION;
          this.lobby.msg('Nobody joined — round skipped. Use the mission board to join the next one.', '#ffb0b0');
          this.ballot = this.makeBallot(); this.myVote = {};
        }
      }
    }
    // the lobby keeps running while you're in it; the match runs whenever it exists
    if (this.view === 'lobby') this.lobby.update(dt);
    if (this.match && !this.starting) {
      this.match.update(dt);
      const m = this.match;
      if (m.over) this.endMatch(m.won ? 'won' : 'died');
      else if (m.ghost && !m.deployedAt && m.time > ABANDON_AFTER) this.endMatch('abandoned');
    }
  }

  render() {
    const g = this.active;
    if (g && g.map) g.render();
  }

  async startMatch() {
    this.state = 'starting';
    this.starting = true;
    this.round++;
    this.lobby.ext.syncInv();
    const L = this.lobby.loadoutSnapshot();
    const n = this.next;
    this.lobby.msg(`Round ${this.round}: ${this.assets.mapIndex[n.map].name} · ${n.mode} · ${n.theme} · ${n.difficulty}`, '#ffd36b');
    const m = new Game(this.canvas, this.assets, this.data, {
      map: this.assets.mapIndex[n.map], cls: this.cls, look: this.look, input: this.input, mode: n.mode, theme: n.theme,
      difficulty: n.difficulty, profile: this.profile, loadout: L, spectate: true,
    });
    m.onEnd = () => {}; m.onWin = () => {};
    await m.start();
    m.session = this;
    this.match = m;
    this.starting = false;
    this.state = 'running';
    if (this.autoDeploy && this.view === 'lobby') this.deploy();
    else this.lobby.msg('Match started without you — walk out a DEPLOY door to join, or spectate from the mission board.', '#7dff8a');
  }

  deploy() {
    if (!this.matchRunning()) return;
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
  retreat() { if (this.match && !this.match.ghost) this.endMatch('retreated'); }

  endMatch(result) {
    const m = this.match;
    if (!m) return;
    const deployed = !!m.deployedAt || !m.ghost;
    const pay = deployed ? payout({ kills: m.kills, alive: m.aliveTime || 0, won: result === 'won', difficulty: m.opts.difficulty }) : null;
    if (pay) {
      // everything you carried or picked up stays in your inventory (even if you died)
      const kept = m.slots.filter(Boolean).map((s) => s.item.name);
      this.profile.inventory = kept.length ? kept : ['Beretta92'];
      this.profile.coins += pay.total;
      this.profile.stats.matches++;
      this.profile.stats.kills += m.kills;
      this.profile.stats.best = Math.max(this.profile.stats.best, Math.round(m.aliveTime || 0));
      this.profile.save();
    }
    if (m.ext) m.ext.stop();
    const summary = { result, deployed, pay, kills: m.kills, alive: m.aliveTime || 0, map: m.opts.map.name, mode: m.opts.mode, difficulty: m.opts.difficulty, wonText: m.won };
    this.match = null;
    this.state = 'intermission';
    this.timer = INTERMISSION;
    this.view = 'lobby';
    this.joined = false;
    this.ballot = this.makeBallot();
    this.myVote = {};
    // back in the lobby with the weapons you kept; ammo and throwables reset
    const lb = this.lobby;
    lb.ammo.slots.length = 0; lb.throwables.counts.clear(); lb.throwables.sel = null; lb.items.clear();
    lb.applyLoadout(lb.classLoadout());
    music('Save Room(RE0)');
    if (summary.deployed) this.ui.results(summary);
    else if (result === 'abandoned') lb.msg('The round ended — nobody deployed.', '#ffb0b0');
  }

  lobbyBanner() {
    const t = Math.max(0, Math.ceil(this.timer));
    const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const n = this.next, name = this.assets.mapIndex[n.map].name;
    if (this.state === 'running' && this.match) return `ROUND ${this.round} IN PROGRESS · ${this.match.opts.map.name} — walk out a DEPLOY door to join`;
    if (this.state === 'starting') return 'STARTING ROUND…';
    return `NEXT ROUND ${clock} · ${name} · ${n.mode} · ${n.difficulty}${this.joined ? ' · JOINED ✓' : ' · not joined (mission board)'}`;
  }
}
