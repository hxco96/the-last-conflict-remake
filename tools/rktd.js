// Minimal Racket datum reader: lists, vectors #(..), dotted pairs, strings, numbers, symbols, #t/#f, ; comments.
const BS = String.fromCharCode(92);
function parse(src) {
  let i = 0; const n = src.length;
  function ws() {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src[i] === ';') { while (i < n && src[i] !== '\n') i++; continue; }
      if (src.startsWith('#;', i)) { i += 2; read(); continue; }
      break;
    }
  }
  function read() {
    ws(); const c = src[i];
    if (c === '(' || c === '[') { i++; return list(c === '(' ? ')' : ']'); }
    if (c === '#' && src[i + 1] === '(') { i += 2; return { vec: list(')') }; }
    if (c === '"') {
      i++; let s = '';
      while (src[i] !== '"') {
        if (src[i] === BS) { i++; const e = src[i]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; }
        else s += src[i];
        i++;
      }
      i++; return s;
    }
    if (c === "'") { i++; return read(); }
    let t = '';
    while (i < n && !/[\s()\[\]";]/.test(src[i])) t += src[i++];
    if (t === '#t' || t === '#true') return true;
    if (t === '#f' || t === '#false') return false;
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
    return { sym: t };
  }
  function list(close) {
    const items = []; let tail;
    for (;;) {
      ws();
      if (src[i] === close) { i++; break; }
      if (src[i] === '.' && /[\s(]/.test(src[i + 1])) { i++; tail = read(); ws(); i++; break; }
      items.push(read());
    }
    return tail === undefined ? items : { pair: items, tail };
  }
  const out = []; ws();
  while (i < n) { out.push(read()); ws(); }
  return out;
}

const isSym = (x) => x && typeof x === 'object' && x.sym !== undefined;
const isField = (e) => (e && e.pair && isSym(e.pair[0])) || (Array.isArray(e) && e.length && isSym(e[0]));

function field(e) {
  if (e.pair) {
    const k = e.pair[0].sym;
    return [k, e.pair.length === 1 ? plain(e.tail) : [...e.pair.slice(1).map(plain), plain(e.tail)]];
  }
  const k = e[0].sym;
  return [k, e.length === 1 ? true : e.length === 2 ? plain(e[1]) : e.slice(1).map(plain)];
}

// Alists become objects; a list headed by a bare symbol followed by fields gets `_tag`.
function plain(x) {
  if (Array.isArray(x)) {
    if (x.length && x.every(isField) && !x.every((e) => Array.isArray(e) && e.length === 1)) return Object.fromEntries(x.map(field));
    if (x.length > 1 && isSym(x[0]) && x.slice(1).every(isField)) return { _tag: x[0].sym, ...Object.fromEntries(x.slice(1).map(field)) };
    return x.map(plain);
  }
  if (x && x.vec) return x.vec.map(plain);
  if (isSym(x)) return x.sym;
  if (x && x.pair) return [...x.pair.map(plain), plain(x.tail)];
  return x;
}

module.exports = { parse, plain };
if (require.main === module) {
  const fs = require('fs');
  const d = parse(fs.readFileSync(process.argv[2], 'utf8')).map(plain);
  fs.writeFileSync(process.argv[3], JSON.stringify(d.length === 1 ? d[0] : d));
}
