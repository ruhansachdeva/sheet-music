// Writes samples/groove.mid: a scale on channel 1 and a drum kit on channel 10,
// so the MIDI path (piano roll, tempo map, channel-10 drums) has something to
// load. Run it with: node tools/make-midi-sample.mjs
//
// Writing the bytes directly keeps this a dev-only script with no dependencies.

import { writeFileSync } from "node:fs";

const PPQ = 480;
const BPM = 120;
const QUARTER = PPQ;
const EIGHTH = PPQ / 2;

/** MIDI stores lengths and delta times as base-128 varints, high bit = more. */
function varint(value) {
    const bytes = [value & 0x7f];
    let rest = value >> 7;
    while (rest > 0) {
        bytes.unshift((rest & 0x7f) | 0x80);
        rest >>= 7;
    }
    return bytes;
}

function chunk(type, bytes) {
    const length = bytes.length;
    return [
        ...[...type].map((c) => c.charCodeAt(0)),
        (length >> 24) & 0xff,
        (length >> 16) & 0xff,
        (length >> 8) & 0xff,
        length & 0xff,
        ...bytes,
    ];
}

/** Absolute-tick events in, a delta-timed MTrk chunk out. */
function track(events) {
    const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
    const bytes = [];
    let last = 0;
    for (const event of sorted) {
        bytes.push(...varint(event.tick - last), ...event.data);
        last = event.tick;
    }
    bytes.push(...varint(0), 0xff, 0x2f, 0x00); // end of track
    return chunk("MTrk", bytes);
}

function text(metaType, value) {
    const bytes = [...value].map((c) => c.charCodeAt(0));
    return [0xff, metaType, ...varint(bytes.length), ...bytes];
}

function noteOn(channel, key, velocity) {
    return [0x90 | channel, key, velocity];
}

function noteOff(channel, key) {
    return [0x80 | channel, key, 0x40];
}

let order = 0;
function at(tick, data) {
    return { tick, data, order: order++ };
}

// --- track 1: tempo and metre ----------------------------------------------

const microsecondsPerQuarter = Math.round(60_000_000 / BPM);
const conductor = [
    at(0, text(0x03, "Groove")),
    at(0, [
        0xff,
        0x51,
        0x03,
        (microsecondsPerQuarter >> 16) & 0xff,
        (microsecondsPerQuarter >> 8) & 0xff,
        microsecondsPerQuarter & 0xff,
    ]),
    at(0, [0xff, 0x58, 0x04, 4, 2, 24, 8]), // 4/4
];

// --- track 2: a C major scale on channel 1 ---------------------------------

const melody = [at(0, text(0x03, "Scale")), at(0, [0xc0, 0])]; // acoustic grand
const scale = [60, 62, 64, 65, 67, 69, 71, 72];
scale.forEach((key, i) => {
    const start = i * QUARTER;
    melody.push(at(start, noteOn(0, key, 90)));
    melody.push(at(start + QUARTER - 10, noteOff(0, key)));
});

// --- track 3: two bars of kit on channel 10 (index 9) ----------------------

const KICK = 36;
const SNARE = 38;
const HIHAT = 42;
const drums = [at(0, text(0x03, "Drums"))];

function hit(tick, key, velocity) {
    drums.push(at(tick, noteOn(9, key, velocity)));
    drums.push(at(tick + 30, noteOff(9, key)));
}

for (let bar = 0; bar < 2; bar++) {
    const barStart = bar * 4 * QUARTER;
    for (let eighth = 0; eighth < 8; eighth++) {
        hit(barStart + eighth * EIGHTH, HIHAT, eighth % 2 === 0 ? 100 : 70);
    }
    hit(barStart + 0 * QUARTER, KICK, 110);
    hit(barStart + 1 * QUARTER, SNARE, 100);
    hit(barStart + 2 * QUARTER, KICK, 110);
    hit(barStart + 3 * QUARTER, SNARE, 100);
}

// --- assemble ---------------------------------------------------------------

const header = chunk("MThd", [
    0x00, 0x01, // format 1: several tracks, one timeline
    0x00, 0x03, // three tracks
    (PPQ >> 8) & 0xff,
    PPQ & 0xff,
]);

const file = Uint8Array.from([
    ...header,
    ...track(conductor),
    ...track(melody),
    ...track(drums),
]);

const path = new URL("../samples/groove.mid", import.meta.url);
writeFileSync(path, file);
console.log(`Wrote ${path.pathname} (${file.length} bytes)`);
