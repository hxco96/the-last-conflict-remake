// FMOD FSB5 (Vorbis) -> standalone .ogg files, pure Node (no libvorbis needed).
//
// FSB5 Vorbis samples are raw Vorbis audio packets with a u16 length prefix; FMOD strips the
// identification/comment/setup headers and stores only the CRC32 of the setup packet. The setup
// packets themselves come from vgmstream's table (src/coding/libs/vorbis_codebooks_fsb.h, itself
// extracted from FMOD by python-fsb5). FSB always uses blocksizes 256/2048.
const fs = require('fs');

// ---------- setup packet table ----------
function loadSetupTable(headerPath) {
  const src = fs.readFileSync(headerPath, 'utf8');
  const map = new Map();
  const re = /static const uint8_t vcb_([0-9a-f]{8})\[\]\s*=\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const bytes = m[2].match(/0x[0-9a-f]{2}/gi).map((h) => parseInt(h, 16));
    map.set(parseInt(m[1], 16) >>> 0, Buffer.from(bytes));
  }
  return map;
}

// ---------- FSB5 container ----------
const FREQ = { 1: 8000, 2: 11000, 3: 11025, 4: 16000, 5: 22050, 6: 24000, 7: 32000, 8: 44100, 9: 48000 };

function parseFsb5(buf, base = 0) {
  if (buf.toString('latin1', base, base + 4) !== 'FSB5') throw new Error('not FSB5');
  const version = buf.readUInt32LE(base + 4);
  const count = buf.readUInt32LE(base + 8);
  const shdrSize = buf.readUInt32LE(base + 12);
  const nameSize = buf.readUInt32LE(base + 16);
  const dataSize = buf.readUInt32LE(base + 20);
  const codec = buf.readUInt32LE(base + 24);
  const hdrSize = version === 0 ? 64 : 60;
  let p = base + hdrSize;
  const samples = [];
  for (let i = 0; i < count; i++) {
    const lo = buf.readUInt32LE(p), hi = buf.readUInt32LE(p + 4);
    p += 8;
    const raw = BigInt(lo) | (BigInt(hi) << 32n);
    const bits = (s, n) => Number((raw >> BigInt(s)) & ((1n << BigInt(n)) - 1n));
    let next = bits(0, 1);
    const s = { freq: FREQ[bits(1, 4)], channels: bits(5, 1) + 1, offset: bits(6, 28) * 16, frames: bits(34, 30), crc: null, loop: null };
    while (next) {
      const c = buf.readUInt32LE(p);
      p += 4;
      next = c & 1;
      const size = (c >>> 1) & 0xffffff;
      const type = (c >>> 25) & 0x7f;
      if (type === 1) s.channels = buf.readUInt8(p);
      else if (type === 2) s.freq = buf.readUInt32LE(p);
      else if (type === 3) s.loop = [buf.readUInt32LE(p), buf.readUInt32LE(p + 4)];
      else if (type === 11) s.crc = buf.readUInt32LE(p) >>> 0;
      p += size;
    }
    samples.push(s);
  }
  const nameStart = base + hdrSize + shdrSize;
  for (let i = 0; i < count; i++) {
    if (!nameSize) { samples[i].name = String(i).padStart(4, '0'); continue; }
    const off = buf.readUInt32LE(nameStart + i * 4);
    const st = nameStart + off;
    samples[i].name = buf.toString('utf8', st, buf.indexOf(0, st));
  }
  const dataStart = nameStart + nameSize;
  for (let i = 0; i < count; i++) {
    const end = i + 1 < count ? samples[i + 1].offset : dataSize;
    samples[i].data = buf.subarray(dataStart + samples[i].offset, dataStart + end);
  }
  return { codec, samples };
}

// ---------- Vorbis bit reader / setup parsing ----------
class BitReader {
  constructor(b) { this.b = b; this.pos = 0; }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3];
      v += ((byte >> (this.pos & 7)) & 1) * 2 ** i;
      this.pos++;
    }
    return v;
  }
}
const ilog = (x) => (x > 0 ? Math.floor(Math.log2(x)) + 1 : 0);
function lookup1(entries, dims) {
  let r = Math.floor(Math.pow(entries, 1 / dims));
  while (Math.pow(r + 1, dims) <= entries) r++;
  while (r > 0 && Math.pow(r, dims) > entries) r--;
  return r;
}

// Returns the per-mode blockflags from a Vorbis setup header packet.
function setupModes(setup, channels) {
  const r = new BitReader(setup);
  if (r.read(8) !== 5) throw new Error('bad setup packet');
  r.read(48); // "vorbis"
  const books = r.read(8) + 1;
  for (let b = 0; b < books; b++) {
    if (r.read(24) !== 0x564342) throw new Error('bad codebook sync');
    const dims = r.read(16), entries = r.read(24);
    if (r.read(1)) { // ordered
      r.read(5);
      for (let cur = 0; cur < entries;) cur += r.read(ilog(entries - cur));
    } else {
      const sparse = r.read(1);
      for (let e = 0; e < entries; e++) { if (!sparse || r.read(1)) r.read(5); }
    }
    const lt = r.read(4);
    if (lt === 1 || lt === 2) {
      r.read(32); r.read(32);
      const vb = r.read(4) + 1;
      r.read(1);
      const n = lt === 1 ? lookup1(entries, dims) : entries * dims;
      r.read(vb * n);
    }
  }
  const times = r.read(6) + 1;
  for (let i = 0; i < times; i++) r.read(16);
  const floors = r.read(6) + 1;
  for (let i = 0; i < floors; i++) {
    const t = r.read(16);
    if (t === 0) {
      r.read(8); r.read(16); r.read(16); r.read(6); r.read(8);
      const nb = r.read(4) + 1;
      for (let k = 0; k < nb; k++) r.read(8);
    } else {
      const parts = r.read(5);
      const pc = [];
      let maxc = -1;
      for (let k = 0; k < parts; k++) { pc.push(r.read(4)); maxc = Math.max(maxc, pc[k]); }
      const cdim = [];
      for (let c = 0; c <= maxc; c++) {
        cdim.push(r.read(3) + 1);
        const sub = r.read(2);
        if (sub) r.read(8);
        for (let k = 0; k < 1 << sub; k++) r.read(8);
      }
      r.read(2);
      const rb = r.read(4);
      for (let k = 0; k < parts; k++) r.read(rb * cdim[pc[k]]);
    }
  }
  const residues = r.read(6) + 1;
  for (let i = 0; i < residues; i++) {
    r.read(16); r.read(24); r.read(24); r.read(24);
    const cls = r.read(6) + 1;
    r.read(8);
    const casc = [];
    for (let c = 0; c < cls; c++) {
      const low = r.read(3);
      const high = r.read(1) ? r.read(5) : 0;
      casc.push(high * 8 + low);
    }
    for (let c = 0; c < cls; c++) for (let j = 0; j < 8; j++) if (casc[c] & (1 << j)) r.read(8);
  }
  const maps = r.read(6) + 1;
  for (let i = 0; i < maps; i++) {
    r.read(16);
    const submaps = r.read(1) ? r.read(4) + 1 : 1;
    if (r.read(1)) {
      const steps = r.read(8) + 1;
      for (let s = 0; s < steps; s++) { r.read(ilog(channels - 1)); r.read(ilog(channels - 1)); }
    }
    r.read(2);
    if (submaps > 1) for (let c = 0; c < channels; c++) r.read(4);
    for (let s = 0; s < submaps; s++) { r.read(8); r.read(8); r.read(8); }
  }
  const modes = r.read(6) + 1;
  const flags = [];
  for (let i = 0; i < modes; i++) { flags.push(r.read(1)); r.read(16); r.read(16); r.read(8); }
  return flags;
}

// ---------- Ogg writer ----------
const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  CRC[i] = c >>> 0;
}
function oggCrc(b) {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return c >>> 0;
}

class OggWriter {
  constructor(serial) { this.serial = serial; this.seq = 0; this.out = []; this.segs = []; this.body = []; this.granule = -1; this.cont = false; }
  page(flags, granule) {
    const h = Buffer.alloc(27 + this.segs.length);
    h.write('OggS', 0, 'latin1');
    h[4] = 0;
    h[5] = flags | (this.cont ? 1 : 0);
    h.writeBigInt64LE(BigInt(granule), 6);
    h.writeUInt32LE(this.serial, 14);
    h.writeUInt32LE(this.seq++, 18);
    h[26] = this.segs.length;
    Buffer.from(this.segs).copy(h, 27);
    const body = Buffer.concat(this.body);
    const page = Buffer.concat([h, body]);
    page.writeUInt32LE(oggCrc(page), 22);
    this.out.push(page);
    this.segs = []; this.body = []; this.granule = -1;
  }
  // Add a packet; flush=true ends the page right after it.
  packet(data, granule, { bos = false, eos = false, flush = false } = {}) {
    let off = 0;
    const lace = [];
    let n = data.length;
    while (n >= 255) { lace.push(255); n -= 255; }
    lace.push(n);
    this.cont = false;
    for (let i = 0; i < lace.length; i++) {
      if (this.segs.length === 255) { this.page(bos && this.seq === 0 ? 2 : 0, this.granule); this.cont = true; }
      this.segs.push(lace[i]);
      this.body.push(data.subarray(off, off + lace[i]));
      off += lace[i];
    }
    this.granule = granule;
    const size = this.body.reduce((a, b) => a + b.length, 0);
    if (flush || eos || size > 4096) { this.page((bos ? 2 : 0) | (eos ? 4 : 0), granule); this.cont = false; }
  }
  bytes() { return Buffer.concat(this.out); }
}

function idHeader(channels, rate) {
  const b = Buffer.alloc(30);
  b[0] = 1; b.write('vorbis', 1, 'latin1');
  b.writeUInt32LE(0, 7); b[11] = channels; b.writeUInt32LE(rate, 12);
  b.writeInt32LE(0, 16); b.writeInt32LE(0, 20); b.writeInt32LE(0, 24);
  b[28] = (8 << 0) | (11 << 4); // blocksize_0 = 2^8 = 256, blocksize_1 = 2^11 = 2048
  b[29] = 1;
  return b;
}
function commentHeader() {
  const vendor = Buffer.from('tlcr-remake fsb5 rebuild', 'latin1');
  const b = Buffer.alloc(7 + 4 + vendor.length + 4 + 1);
  b[0] = 3; b.write('vorbis', 1, 'latin1');
  b.writeUInt32LE(vendor.length, 7); vendor.copy(b, 11);
  b.writeUInt32LE(0, 11 + vendor.length);
  b[b.length - 1] = 1;
  return b;
}

function sampleToOgg(s, setups, serial = 1) {
  const setup = setups.get(s.crc);
  if (!setup) throw new Error(`no setup packet for crc ${s.crc.toString(16)}`);
  const flags = setupModes(setup, s.channels);
  const modeBits = ilog(flags.length - 1);
  const w = new OggWriter(serial);
  w.packet(idHeader(s.channels, s.freq), 0, { bos: true, flush: true });
  w.packet(commentHeader(), 0);
  w.packet(setup, 0, { flush: true });
  const packets = [];
  for (let p = 0; p + 2 <= s.data.length;) {
    const n = s.data.readUInt16LE(p);
    if (n === 0 || n === 0xffff || p + 2 + n > s.data.length) break;
    packets.push(s.data.subarray(p + 2, p + 2 + n));
    p += 2 + n;
  }
  let granule = 0, prev = 0;
  packets.forEach((pk, i) => {
    const mode = modeBits ? (pk[0] >> 1) & ((1 << modeBits) - 1) : 0;
    const bs = flags[mode] ? 2048 : 256;
    if (prev) granule += (bs + prev) / 4;
    prev = bs;
    const last = i === packets.length - 1;
    w.packet(pk, last ? Math.min(granule, s.frames) || granule : granule, { eos: last });
  });
  return { ogg: w.bytes(), packets: packets.length, duration: s.frames / s.freq };
}

module.exports = { loadSetupTable, parseFsb5, sampleToOgg };
