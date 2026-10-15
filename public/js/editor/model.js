// The model behind writing a score by hand, and the MusicXML it turns into.
//
// A score here is a flat run of notes and rests. Bar lines are worked out when
// it is written: notes are packed into measures, and a note that will not fit
// is split across the bar line and tied, which is what a copyist would do.

import { GM_DRUM_NAMES, KIT } from "../drums.js";

export const DIVISIONS = 480; // ticks per quarter note

/** Note lengths, longest first - the order the splitter relies on. */
export const DURATIONS = [
    { name: "whole", label: "whole note", ticks: DIVISIONS * 4 },
    { name: "half", label: "half note", ticks: DIVISIONS * 2 },
    { name: "quarter", label: "quarter note", ticks: DIVISIONS },
    { name: "eighth", label: "eighth note", ticks: DIVISIONS / 2 },
    { name: "16th", label: "sixteenth note", ticks: DIVISIONS / 4 },
];

/**
 * Shorter values the palette does not offer, used only to split a note at a
 * bar line. Mixing dotted sixteenths with triplets can leave a few ticks
 * before the bar line - 60, say - that no palette value can fill.
 */
const SPLIT_ONLY = [
    { name: "32nd", ticks: DIVISIONS / 8 },
    { name: "64th", ticks: DIVISIONS / 16 },
];

const BY_NAME = Object.fromEntries([...DURATIONS, ...SPLIT_ONLY].map((d) => [d.name, d]));

/** Ticks a note lasts, including its dot. */
export function ticksOf({ duration, dots = 0, tuplet = 0 }) {
    const base = BY_NAME[duration].ticks;
    const dotted = dots ? base * 1.5 : base;
    // A triplet is three in the time of two.
    return tuplet === 3 ? (dotted * 2) / 3 : dotted;
}

/**
 * Every writable length, longest first: each note type dotted and plain, and
 * as a triplet. The triplets let a bar with a triplet in it still be filled
 * exactly: without them a leftover like 160 ticks (one triplet eighth) cannot
 * be written at all, and the bar would come up short.
 */
const WRITABLE = DURATIONS.flatMap((d) => [
    { duration: d.name, dots: 1, tuplet: 0, ticks: d.ticks * 1.5 },
    { duration: d.name, dots: 0, tuplet: 0, ticks: d.ticks },
    { duration: d.name, dots: 0, tuplet: 3, ticks: (d.ticks * 2) / 3 },
])
    .concat([
        // With these, every multiple of 20 ticks can be written exactly.
        { duration: "32nd", dots: 0, tuplet: 0, ticks: DIVISIONS / 8 },
        { duration: "32nd", dots: 0, tuplet: 3, ticks: DIVISIONS / 12 },
        { duration: "64th", dots: 0, tuplet: 3, ticks: DIVISIONS / 24 },
    ])
    .sort((a, b) => b.ticks - a.ticks || a.tuplet - b.tuplet);

/**
 * Breaks a length into note values that can actually be written. A tie across
 * a bar line can leave a length no single note can express (five eighths, say),
 * so it becomes several notes tied together.
 */
export function decompose(ticks) {
    // Every writable length is a whole number of these (the dotted sixteenth,
    // 180, and the sixteenth triplet, 80, set it), so lengths can be counted.
    const UNIT = 20;
    const units = Math.round(ticks / UNIT);

    // best[n]: the best way to write n units, or undefined if there is none.
    // Picking the longest value first, as this once did, can strand a
    // remainder nothing writes - 1320 ticks as a whole-note triplet leaves 40
    // - and the bar came up short. Searching every way to add up avoids that.
    const best = [[]];
    for (let n = 1; n <= units; n++) {
        for (const value of WRITABLE) {
            const size = value.ticks / UNIT;
            const rest = best[n - size];
            if (size > n || !Number.isInteger(size) || !rest) continue;
            const candidate = [value, ...rest].sort((a, b) => b.ticks - a.ticks);
            if (!best[n] || betterSplit(candidate, best[n])) best[n] = candidate;
        }
    }

    return (best[units] ?? []).map((value) => ({
        duration: value.duration,
        dots: value.dots,
        ...(value.tuplet ? { tuplet: value.tuplet } : {}),
    }));
}

/**
 * Fewer notes is the better split, then fewer triplets - a plain length split
 * by a bar line should stay plain - then the longer notes first.
 */
function betterSplit(a, b) {
    if (a.length !== b.length) return a.length < b.length;
    const triplets = (split) => split.filter((value) => value.tuplet).length;
    if (triplets(a) !== triplets(b)) return triplets(a) < triplets(b);
    for (let i = 0; i < a.length; i++) {
        if (a[i].ticks !== b[i].ticks) return a[i].ticks > b[i].ticks;
    }
    return false;
}

export const SHARP = 1;
export const FLAT = -1;

/** Major keys, by the number of sharps (positive) or flats (negative). */
export const KEY_SIGNATURES = [
    { fifths: 0, name: "C" },
    { fifths: 1, name: "G" },
    { fifths: 2, name: "D" },
    { fifths: 3, name: "A" },
    { fifths: 4, name: "E" },
    { fifths: 5, name: "B" },
    { fifths: -1, name: "F" },
    { fifths: -2, name: "B♭" },
    { fifths: -3, name: "E♭" },
    { fifths: -4, name: "A♭" },
    { fifths: -5, name: "D♭" },
];

/** How a key signature spells a black key when nothing says otherwise. */
export function keyPrefers(fifths) {
    return fifths < 0 ? FLAT : SHARP;
}

/** A fresh, empty score. `kind` is "pitched" or "drums". */
export function emptyScore(kind = "pitched") {
    return {
        title: "Untitled",
        tempo: 100,
        beats: 4,
        beatType: 4,
        fifths: 0,
        clef: kind === "drums" ? "percussion" : "treble",
        kind,
        notes: [],
    };
}

/** MIDI number to the step, octave and alteration MusicXML wants. */
const STEPS = [
    ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0],
    ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0],
];

export function spellMidi(midi, prefer = SHARP) {
    const octave = Math.floor(midi / 12) - 1;
    const [step, alter] = STEPS[((midi % 12) + 12) % 12];

    // The same key spelled downwards: C#4 becomes Db4.
    if (alter === 1 && prefer === FLAT) {
        const [nextStep] = STEPS[(((midi + 1) % 12) + 12) % 12];
        return { step: nextStep, alter: -1, octave: midi % 12 === 11 ? octave + 1 : octave };
    }
    return { step, alter, octave };
}

/**
 * The pitches or kit pieces a note sounds, in the order they are written. A
 * pitch is spelled the way the key that was pressed was labelled, falling back
 * to the key signature's preference.
 */
function pitchesOf(note, fallback = SHARP) {
    if (note.drums?.length) {
        return note.drums.map((gm) => {
            const piece = KIT.find((k) => k.gm === gm);
            return { drum: piece ? { ...spellMidi(piece.staff), ...piece } : null };
        });
    }
    const midis = note.midis?.length ? note.midis : [note.midi];
    return midis.map((midi) => ({
        pitch: spellMidi(midi, note.spell?.[midi] ?? note.prefer ?? fallback),
    }));
}

function escapeXml(text) {
    return String(text).replace(/[<>&'"]/g, (c) =>
        ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c],
    );
}

/**
 * One <note>, with its children in the order the MusicXML schema requires:
 * chord, pitch, duration, tie, instrument, voice, type, dot, time-modification,
 * notehead, notations. Lenient readers accept them in any order; stricter ones
 * (MuseScore among them) reject a file that gets it wrong.
 */
function noteXml({ part, pitch, drum, chord, tieStart, tieStop, tupletStart, tupletStop }) {
    const lines = ["      <note>"];

    // Marks this as sounding with the note before it rather than after it.
    if (chord) lines.push("        <chord/>");

    if (drum) {
        // An unpitched note says where it sits on the staff, and points at the
        // score-instrument that says which drum that is.
        lines.push("        <unpitched>");
        lines.push(`          <display-step>${drum.step}</display-step>`);
        lines.push(`          <display-octave>${drum.octave}</display-octave>`);
        lines.push("        </unpitched>");
    } else if (!pitch) {
        lines.push("        <rest/>");
    } else {
        lines.push("        <pitch>");
        lines.push(`          <step>${pitch.step}</step>`);
        if (pitch.alter) lines.push(`          <alter>${pitch.alter}</alter>`);
        lines.push(`          <octave>${pitch.octave}</octave>`);
        lines.push("        </pitch>");
    }

    lines.push(`        <duration>${Math.round(part.ticks)}</duration>`);
    if (tieStop) lines.push('        <tie type="stop"/>');
    if (tieStart) lines.push('        <tie type="start"/>');
    if (drum) lines.push(`        <instrument id="P1-I${drum.gm}"/>`);
    lines.push("        <voice>1</voice>");
    lines.push(`        <type>${part.duration}</type>`);
    for (let i = 0; i < part.dots; i++) lines.push("        <dot/>");
    if (part.tuplet === 3) {
        // Three in the time of two.
        lines.push("        <time-modification>");
        lines.push("          <actual-notes>3</actual-notes>");
        lines.push("          <normal-notes>2</normal-notes>");
        lines.push("        </time-modification>");
    }
    if (drum?.cross) lines.push("        <notehead>x</notehead>");

    if (tieStart || tieStop || tupletStart || tupletStop) {
        lines.push("        <notations>");
        if (tieStop) lines.push('          <tied type="stop"/>');
        if (tieStart) lines.push('          <tied type="start"/>');
        if (tupletStart) lines.push('          <tuplet type="start" bracket="yes"/>');
        if (tupletStop) lines.push('          <tuplet type="stop"/>');
        lines.push("        </notations>");
    }

    lines.push("      </note>");
    return lines.join("\n");
}

/**
 * Marks the start and end of each triplet bracket in a measure: every three
 * consecutive triplet notes of the same value make one group. A group left
 * short at the end of the bar is closed where it stops.
 */
function bracketTuplets(entries) {
    let group = [];
    const close = () => {
        if (group.length) {
            group[0].tupletStart = true;
            group[group.length - 1].tupletStop = true;
        }
        group = [];
    };

    for (const entry of entries) {
        if (entry.chord) continue; // a chord's other notes share its bracket
        const isTriplet = entry.part.tuplet === 3;
        if (!isTriplet || (group.length && group[0].part.duration !== entry.part.duration)) close();
        if (!isTriplet) continue;
        group.push(entry);
        if (group.length === 3) close();
    }
    close();
}

/**
 * Writes the score as MusicXML 3.1, packing notes into measures and tying
 * anything that crosses a bar line. Every measure comes out full: a short last
 * measure is padded with rests, so the file is valid and plays correctly.
 */
export function toMusicXml(score) {
    const perMeasure = (DIVISIONS * 4 * score.beats) / score.beatType;
    const measures = [];
    let current = [];
    let filled = 0;

    const startMeasure = () => {
        measures.push(current);
        current = [];
        filled = 0;
    };

    for (const note of score.notes) {
        let left = ticksOf(note);
        let first = true;

        while (left > 0) {
            const room = perMeasure - filled;
            const take = Math.min(room, left);

            // A note that fits the bar whole is written as the value that was
            // chosen - a triplet stays a triplet - and only a note split by
            // the bar line is broken into whatever values add up.
            const whole = first && take === ticksOf(note);
            const parts = whole
                ? [{ duration: note.duration, dots: note.dots ?? 0, ...(note.tuplet ? { tuplet: note.tuplet } : {}) }]
                : decompose(take);
            const spansMore = left - take > 0;

            for (const [index, part] of parts.entries()) {
                const isLast = index === parts.length - 1;

                // A chord is one note followed by the rest of its pitches,
                // each marked as sounding with it rather than after it.
                const voices = note.rest ? [null] : pitchesOf(note, keyPrefers(score.fifths));

                for (const [voiceIndex, voice] of voices.entries()) {
                    current.push({
                        part: { ...part, ticks: ticksOf(part) },
                        drum: voice?.drum ?? null,
                        pitch: voice?.pitch ?? null,
                        chord: voiceIndex > 0,
                        // Every piece of a split note is tied to the next, and
                        // to the one before it. A rest is never tied.
                        tieStart: !note.rest && (!isLast || spansMore),
                        tieStop: !note.rest && !first,
                        clef: score.clef,
                    });
                }
                first = false;
            }

            filled += take;
            left -= take;
            if (filled >= perMeasure - 1e-9) startMeasure();
        }
    }

    // Pad the last measure so it adds up, then flush it.
    if (current.length > 0 || measures.length === 0) {
        const room = perMeasure - filled;
        if (room > 0) {
            for (const part of decompose(room)) {
                current.push({
                    part: { ...part, ticks: ticksOf(part) },
                    pitch: null,
                    clef: score.clef,
                });
            }
        }
        measures.push(current);
    }

    const isDrums = score.kind === "drums";
    const clefXml = isDrums
        ? "        <sign>percussion</sign>\n        <line>2</line>"
        : score.clef === "bass"
          ? "        <sign>F</sign>\n        <line>4</line>"
          : "        <sign>G</sign>\n        <line>2</line>";

    // One score-instrument per drum actually used, each naming its General
    // MIDI number so the player knows which kit piece to sound.
    const used = [
        ...new Set(score.notes.filter((n) => !n.rest).flatMap((n) => n.drums ?? [])),
    ];
    const kitXml = used
        .map(
            (gm) => `      <score-instrument id="P1-I${gm}">
        <instrument-name>${GM_DRUM_NAMES[gm] ?? `Drum ${gm}`}</instrument-name>
      </score-instrument>`,
        )
        .concat(
            used.map(
                // midi-unpitched counts from 1, so the bass drum at 36 is 37.
                (gm) => `      <midi-instrument id="P1-I${gm}">
        <midi-channel>10</midi-channel>
        <midi-unpitched>${gm + 1}</midi-unpitched>
      </midi-instrument>`,
            ),
        )
        .join("\n");

    const body = measures
        .map((notes, index) => {
            const attributes =
                index === 0
                    ? `      <attributes>
        <divisions>${DIVISIONS}</divisions>
        <key><fifths>${score.fifths}</fifths></key>
        <time><beats>${score.beats}</beats><beat-type>${score.beatType}</beat-type></time>
        <clef>
${clefXml}
        </clef>
      </attributes>
      <direction placement="above">
        <direction-type>
          <metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome>
        </direction-type>
        <sound tempo="${score.tempo}"/>
      </direction>
`
                    : "";
            bracketTuplets(notes);
            return `    <measure number="${index + 1}">\n${attributes}${notes
                .map(noteXml)
                .join("\n")}\n    </measure>`;
        })
        .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN"
    "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work>
    <work-title>${escapeXml(score.title)}</work-title>
  </work>
  <part-list>
    <score-part id="P1">
      <part-name>${escapeXml(isDrums ? "Drum Set" : score.title)}</part-name>
${kitXml}
    </score-part>
  </part-list>
  <part id="P1">
${body}
  </part>
</score-partwise>
`;
}
