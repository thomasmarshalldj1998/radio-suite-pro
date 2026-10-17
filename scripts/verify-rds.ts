/**
 * Independent verification of the RDS encoder — pure DSP, no browser APIs.
 *
 *   bun scripts/verify-rds.ts
 *
 * The decoder here is written from the standard rather than reusing the
 * generator's helpers: its own CRC-10 (x¹⁰+x⁸+x⁷+x⁵+x⁴+x³+1) and the IEC 62106
 * offset words (A 0x0FC, B 0x198, C 0x168, D 0x1B4) are spelled out again, so a
 * mistake in the generator cannot be cancelled out by the same mistake here.
 *
 * Checks:
 *   1  block framing — every 26-bit block's syndrome matches its offset word
 *   2  programme identification and programme type survive the round trip
 *   3  group 0A — PS assembles across its four segment addresses
 *   4  group 0A — the alternative-frequency list is announced honestly
 *   5  group 2A — RadioText assembles and terminates with 0x0D
 *   6  the 0A:2A cadence (one text group per four PS groups)
 *   7  delayed text: a change is held for the configured delay, then applies
 *   8  scrolling PS: a longer name moves through the 8-character window
 *   9  RadioText Plus: the 3A announcement names aid 0x4BD7 and group 11A
 *  10  RadioText Plus: the 11A tags address real character ranges of the text
 *  11  RadioText Plus: the item toggle flips when the text becomes a new item
 */

let passed = 0;
let failed = 0;

function check(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ── spec constants, restated independently ────────────────────────────── */

const POLY = 0b10110111001;
const OFFSETS = { A: 0x0fc, B: 0x198, C: 0x168, D: 0x1b4 } as const;

/** CRC-10 as defined in IEC 62106 §3.2.2, computed long-division style. */
function crc10(data16: number): number {
  let reg = (data16 & 0xffff) << 10;
  for (let i = 25; i >= 10; i--) {
    if (reg & (1 << i)) reg ^= POLY << (i - 10);
  }
  return reg & 0x3ff;
}

/** Syndrome of a received 26-bit block: 0 means the offset word matched. */
function syndrome(word: number, offset: number): number {
  const payload = (word >>> 10) & 0xffff;
  const received = word & 0x3ff;
  return (crc10(payload) ^ offset ^ received) & 0x3ff;
}

function readBitSource(rds: { next(): number }): number[] {
  return Array.from({ length: 104 }, () => rds.next());
}

interface Group {
  type: number;
  version: number;
  pi: number;
  b: number;
  c: number;
  d: number;
  offsetsOk: boolean;
}

function decodeGroup(bits: number[]): Group {
  const words = [0, 1, 2, 3].map((i) =>
    bits.slice(i * 26, i * 26 + 26).reduce((acc, bit) => (acc << 1) | bit, 0),
  );
  const names = ["A", "B", "C", "D"] as const;
  const offsetsOk = words.every(
    (word, i) => syndrome(word, OFFSETS[names[i]]) === 0,
  );
  const data = words.map((word) => (word >>> 10) & 0xffff);
  const blockB = data[1];
  return {
    type: (blockB >> 12) & 0xf,
    version: (blockB >> 11) & 1,
    pi: data[0],
    b: blockB,
    c: data[2],
    d: data[3],
    offsetsOk,
  };
}

const { RdsBitSource } = await import("../src/lib/audio/mpx");

/** RT+ tag group fields, unpacked from blocks B, C and D. */
interface Tags11A {
  toggle: number;
  running: number;
  first: { type: number; start: number; len: number };
  second: { type: number; start: number; len: number };
}

function decodeTags(g: Group): Tags11A {
  const t1type = (((g.b & 0b111) << 3) | ((g.c >> 13) & 0b111)) & 0x3f;
  const t2type = (((g.c & 1) << 5) | ((g.d >> 11) & 0b11111)) & 0x3f;
  return {
    toggle: (g.b >> 4) & 1,
    running: (g.b >> 3) & 1,
    first: { type: t1type, start: (g.c >> 7) & 0x3f, len: (g.c >> 1) & 0x3f },
    second: { type: t2type, start: (g.d >> 5) & 0x3f, len: g.d & 0x1f },
  };
}

/** Slice what a receiver would highlight for a tag out of the RadioText. */
function tagged(text: string, tag: { start: number; len: number }): string {
  return text.slice(tag.start, tag.start + tag.len + 1);
}

/* ── 1-5: a full field set round-trips ─────────────────────────────────── */

console.log("\n1 · framing, identification and text");
const PI = "C479";
const PS = "SIGNAL  ";
const RT = "Now playing: Test Song";
const rds = new RdsBitSource(RdsBitSource.parsePi(PI), PS, 14);
rds.setConfig({ rt: RT, af: [96.4], scroll: false, delayMs: 0 });

const groups: Group[] = [];
for (let i = 0; i < 40; i++) groups.push(decodeGroup(readBitSource(rds)));

check(
  groups.every((g) => g.offsetsOk),
  "every block syndrome matches its offset word",
  `${groups.length * 4} blocks`,
);
check(
  groups.every((g) => g.pi === 0xc479),
  "PI is carried in block A of every group",
  `0x${groups[0].pi.toString(16).toUpperCase()}`,
);
check(
  groups.every((g) => ((g.b >> 5) & 0x1f) === 14),
  "PTY is carried in block B of every group",
  `PTY ${(groups[0].b >> 5) & 0x1f}`,
);

// 0A: two PS characters per group across four segment addresses
const psChars = new Array(8).fill(" ");
const psSeen = new Set<number>();
for (const g of groups) {
  if (g.type !== 0 || g.version !== 0) continue;
  const seg = g.b & 0x3;
  psSeen.add(seg);
  psChars[2 * seg] = String.fromCharCode((g.d >> 8) & 0xff);
  psChars[2 * seg + 1] = String.fromCharCode(g.d & 0xff);
}
check(
  psSeen.size === 4,
  "PS arrives on all four segment addresses",
  `saw ${[...psSeen].sort().join(",")}`,
);
check(psChars.join("") === PS, "PS reassembles", JSON.stringify(psChars.join("")));

// 0A block C: AF count + first alternative (96.4 MHz → code 89)
const afGroup = groups.find((g) => g.type === 0 && g.version === 0);
const afCount = afGroup ? (afGroup.c >> 8) & 0xff : -1;
const afCode = afGroup ? afGroup.c & 0xff : -1;
check(
  afCount === 1 && afCode === 89,
  "AF list announces one alternative at the right code",
  `count=${afCount} code=${afCode} (96.4 MHz)`,
);

// 2A: four RadioText characters per group across sixteen addresses
const rtChars = new Array(64).fill(0);
const rtSeen = new Set<number>();
for (const g of groups) {
  if (g.type !== 2 || g.version !== 0) continue;
  const seg = g.b & 0xf;
  rtSeen.add(seg);
  rtChars[seg * 4] = (g.c >> 8) & 0xff;
  rtChars[seg * 4 + 1] = g.c & 0xff;
  rtChars[seg * 4 + 2] = (g.d >> 8) & 0xff;
  rtChars[seg * 4 + 3] = g.d & 0xff;
}
const rtText = rtChars
  .map((c) => String.fromCharCode(c))
  .join("")
  .split("\r")[0];
check(
  rtText === RT,
  "RadioText reassembles and terminates with 0x0D",
  JSON.stringify(rtText),
);
check(rtSeen.size >= 5, "RadioText segments advance", `${rtSeen.size} seen`);

/* ── 6: cadence ────────────────────────────────────────────────────────── */

console.log("\n2 · group cadence");
const types = groups.map((g) => g.type);
check(
  types.filter((t) => t === 0).length === 32 &&
    types.filter((t) => t === 2).length === 8,
  "one 2A group per four 0A groups",
  `${types.filter((t) => t === 0).length}×0A · ${types.filter((t) => t === 2).length}×2A`,
);
check(
  types.slice(0, 5).join("") === "00002",
  "the first four groups are PS, the fifth is text",
  types.slice(0, 5).join(""),
);

/* ── 7: delayed text ───────────────────────────────────────────────────── */

console.log("\n3 · delayed text");
const delayed = new RdsBitSource(RdsBitSource.parsePi(PI), PS, 14);
delayed.setConfig({ rt: "OLD TEXT" });

/**
 * Read a whole RadioText pass. Twenty-two text groups (88 groups total) more
 * than covers the sixteen addresses, so nothing is left unseen; unread
 * addresses fall back to the 0x0D terminator the encoder pads with.
 */
const readRt = (src: { next(): number }, count = 88): string => {
  const chars = new Array(64).fill(0x0d);
  for (let i = 0; i < count; i++) {
    const g = decodeGroup(readBitSource(src));
    if (g.type !== 2) continue;
    const seg = g.b & 0xf;
    chars[seg * 4] = (g.c >> 8) & 0xff;
    chars[seg * 4 + 1] = g.c & 0xff;
    chars[seg * 4 + 2] = (g.d >> 8) & 0xff;
    chars[seg * 4 + 3] = g.d & 0xff;
  }
  return chars.map((c) => String.fromCharCode(c)).join("").split("\r")[0];
};

check(readRt(delayed) === "OLD TEXT", "the first value shows immediately");
delayed.setConfig({ delayMs: 1200 });
delayed.setConfig({ rt: "NEW TEXT AFTER DELAY" });
const held = readRt(delayed);
check(
  held === "OLD TEXT",
  "a change is held while the delay is outstanding",
  `showing ${JSON.stringify(held)}`,
);
await Bun.sleep(1400);
const landed = readRt(delayed);
check(
  landed === "NEW TEXT AFTER DELAY",
  "the held change lands once the delay expires",
  `showing ${JSON.stringify(landed)}`,
);

/* ── 8: scrolling PS ───────────────────────────────────────────────────── */

console.log("\n4 · scrolling PS");
const scroller = new RdsBitSource(RdsBitSource.parsePi(PI), "SIGNALPATH RADIO", 14);
scroller.setConfig({ scroll: true });
const windows = new Set<string>();
for (let cycle = 0; cycle < 20; cycle++) {
  const win = new Array(8).fill(" ");
  for (let i = 0; i < 4; i++) {
    const g = decodeGroup(readBitSource(scroller));
    const seg = g.b & 0x3;
    win[2 * seg] = String.fromCharCode((g.d >> 8) & 0xff);
    win[2 * seg + 1] = String.fromCharCode(g.d & 0xff);
  }
  windows.add(win.join(""));
}
check(windows.size > 1, "the 8-character window moves", `${windows.size} distinct`);
check(
  [...windows].every((w) => /^[\x20-\x7e]{8}$/.test(w)),
  "every window is exactly eight printable characters",
);

/* ── 9-11: RadioText Plus (3A announcement + 11A tags) ──────────────────── */

console.log("\n5 · RadioText Plus");
const ARTIST = "Kate Bush";
const TITLE = "Running Up That Hill";
const plus = new RdsBitSource(RdsBitSource.parsePi(PI), PS, 14);
plus.setConfig({ rt: `${ARTIST} - ${TITLE}`, rtPlus: true });

const plusGroups: Group[] = [];
for (let i = 0; i < 24; i++) plusGroups.push(decodeGroup(readBitSource(plus)));

const ann = plusGroups.find((g) => g.type === 3 && g.version === 0);
check(
  ann !== undefined,
  "a 3A announcement is sent in the cycle",
  `${plusGroups.filter((g) => g.type === 3).length} per 24 groups`,
);
check(
  ann !== undefined && (ann.b & 0b11111) === 0b10110,
  "the AGTC names group 11A as the data carrier",
  ann ? `AGTC 0b${(ann.b & 0b11111).toString(2)}` : "no announcement",
);
check(
  ann !== undefined && ann.c === 0x4bd7,
  "block C carries the RT+ application identification",
  ann ? `AID 0x${ann.c.toString(16).toUpperCase()}` : "no announcement",
);

const tagGroups = plusGroups.filter((g) => g.type === 11 && g.version === 0);
check(tagGroups.length > 0, "11A tag groups follow the announcement", `${tagGroups.length} seen`);
const decoded = decodeTags(tagGroups[0]);
check(
  decoded.first.type === 4 && decoded.second.type === 1,
  "tag 1 is Item.Artist and tag 2 is Item.Title",
  `types ${decoded.first.type}, ${decoded.second.type}`,
);
check(
  tagged(ARTIST + " - " + TITLE, decoded.first) === ARTIST,
  "tag 1 addresses exactly the artist",
  JSON.stringify(tagged(ARTIST + " - " + TITLE, decoded.first)),
);
check(
  tagged(ARTIST + " - " + TITLE, decoded.second) === TITLE,
  "tag 2 addresses exactly the title",
  JSON.stringify(tagged(ARTIST + " - " + TITLE, decoded.second)),
);
check(decoded.running === 1, "the item running bit is set while text is on air");

// the toggle must flip when the text becomes a new item, and hold otherwise
const toggles = tagGroups.map((g) => decodeTags(g).toggle);
check(
  toggles.every((t) => t === toggles[0]),
  "the toggle holds for as long as the item does not change",
  toggles.join(""),
);
plus.setConfig({ rt: `Kate Bush - Hounds of Love` });
const after: number[] = [];
for (let i = 0; i < 24; i++) {
  const g = decodeGroup(readBitSource(plus));
  if (g.type === 11 && g.version === 0) after.push(decodeTags(g).toggle);
}
check(
  after.length > 0 && after.every((t) => t !== toggles[0]),
  "the toggle flips for a new item",
  `${toggles[0]} → ${after[0]}`,
);

// RT+ off must leave no ODA groups at all
const plain = new RdsBitSource(RdsBitSource.parsePi(PI), PS, 14);
plain.setConfig({ rt: "Plain text only", rtPlus: false });
const plainTypes = Array.from({ length: 10 }, () => decodeGroup(readBitSource(plain)).type);
check(
  !plainTypes.includes(3) && !plainTypes.includes(11),
  "no ODA groups are sent when RT+ is off",
  plainTypes.join(""),
);

console.log(
  `\n${passed} checks passed, ${failed} failed${failed ? " — RDS IS NOT CORRECT" : ""}.`,
);
process.exit(failed ? 1 : 0);
