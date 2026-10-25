// Grid flow field toward the player. Barricades and closed doors are passable at a high
// cost, so mobs route around them when they can and break through when they can't.

const DIRS = [[1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10], [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14]];
const BREACH_COST = 80;

export class FlowField {
  constructor(map) {
    this.map = map;
    this.dist = new Int32Array(map.w * map.h).fill(-1);
    this.heap = [];
  }

  cellCost(i) {
    const m = this.map;
    if (m.solid[i]) return -1;
    const d = m.dyn[i];
    if (d && (d.kind === 'door' ? !d.open : d.hp > 0)) return BREACH_COST;
    return 0;
  }

  compute(tx, ty) {
    const m = this.map, w = m.w, h = m.h, dist = this.dist;
    dist.fill(-1);
    if (!m.inBounds(tx, ty)) return;
    const heap = this.heap;
    heap.length = 0;
    const push = (d, i) => {
      heap.push([d, i]);
      let k = heap.length - 1;
      while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let s = k;
          if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
          if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
          if (s === k) break;
          [heap[s], heap[k]] = [heap[k], heap[s]];
          k = s;
        }
      }
      return top;
    };
    const start = ty * w + tx;
    dist[start] = 0;
    push(0, start);
    while (heap.length) {
      const [d, i] = pop();
      if (d > dist[i] && dist[i] !== -1) continue;
      const cx = i % w, cy = (i / w) | 0;
      for (const [dx, dy, c] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (dx && dy && (m.solid[cy * w + nx] || m.solid[ny * w + cx])) continue;
        const ni = ny * w + nx;
        const extra = this.cellCost(ni);
        if (extra < 0) continue;
        const nd = d + c + extra;
        if (dist[ni] === -1 || nd < dist[ni]) { dist[ni] = nd; push(nd, ni); }
      }
    }
  }

  // Best neighbouring cell to step into from (cx, cy), or null.
  next(cx, cy) {
    const m = this.map, w = m.w;
    if (!m.inBounds(cx, cy)) return null;
    const here = this.dist[cy * w + cx];
    let best = null, bestD = here === -1 ? Infinity : here;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!m.inBounds(nx, ny)) continue;
      if (dx && dy && (m.blocking(nx, cy) || m.blocking(cx, ny))) continue;
      const d = this.dist[ny * w + nx];
      if (d !== -1 && d < bestD) { bestD = d; best = [nx, ny]; }
    }
    return best;
  }
}
