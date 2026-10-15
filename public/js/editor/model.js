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

const BY_NAME = Object.fromEntries(DURATIONS.map((d) => [d.name, d]));

/** Ticks a note lasts, including its dot. */
export function ticksOf({ duration, dots = 0 }) {
    const base = BY_NAME[duration].ticks;
    return dots ? base * 1.5 : base;
}

/** Every writable length, longest first: each note type, dotted and plain. */
const WRITABLE = DURATIONS.flatMap((d) => [
    { duration: d.name, dots: 1, ticks: d.ticks * 1.5 },
    { duration: d.name, dots: 0, ticks: d.ticks },
]).sort((a, b) => b.ticks - a.ticks);

/**
 * Breaks a length into note values that can actually be written. A tie across
 * a bar line can leave a length no single note can express (five eighths, say),
 * so it becomes several notes tied together.
 */
export function decompose(ticks) {
    const parts = [];
    let left = ticks;

    while (left > 0) {
        const fits = WRITABLE.find((w) => w.ticks <= left + 1e-9);
        if (!fits) break; // shorter than a 16th: not writable, so drop the rest
        parts.push({ duration: fits.duration, dots: fits.dots });
        left -= fits.ticks;
    }
    return parts;
}

export const SHARP = 1;
export const FLAT = -1;

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

function escapeXml(text) {
    return String(text).replace(/[<>&'"]/g, (c) =>
        ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c],
    );
}

function noteXml({ part, pitch, drum, tieStart, tieStop, clef }) {
    const lines = ["      <note>"];

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
        if (tieStop) lines.push('        <tie type="stop"/>');
        if (tieStart) lines.push('        <tie type="start"/>');
        lines.push("        <pitch>");
        lines.push(`          <step>${pitch.step}</step>`);
        if (pitch.alter) lines.push(`          <alter>${pitch.alter}</alter>`);
        lines.push(`          <octave>${pitch.octave}</octave>`);
        lines.push("        </pitch>");
    }

    lines.push(`        <duration>${Math.round(part.ticks)}</duration>`);
    if (drum) lines.push(`        <instrument id="P1-I${drum.gm}"/>`);
    lines.push("        <voice>1</voice>");
    lines.push(`        <type>${part.duration}</type>`);
    for (let i = 0; i < part.dots; i++) lines.push("        <dot/>");
    if (drum?.cross) lines.push("        <notehead>x</notehead>");

    if (tieStart || tieStop) {
        lines.push("        <notations>");
        if (tieStop) lines.push('          <tied type="stop"/>');
        if (tieStart) lines.push('          <tied type="start"/>');
        lines.push("        </notations>");
    }

    lines.push("      </note>");
    return lines.join("\n");
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

            const parts = decompose(take);
            const spansMore = left - take > 0;

            for (const [index, part] of parts.entries()) {
                const isLast = index === parts.length - 1;

                const piece = note.drum != null ? KIT.find((k) => k.gm === note.drum) : null;

                current.push({
                    part: { ...part, ticks: ticksOf(part) },
                    drum: piece && !note.rest ? { ...spellMidi(piece.staff), ...piece } : null,
                    pitch: note.rest || piece ? null : spellMidi(note.midi, note.prefer ?? SHARP),
                    // Every piece of a split note is tied to the next, and to
                    // the one before it. A rest is never tied.
                    tieStart: !note.rest && (!isLast || spansMore),
                    tieStop: !note.rest && !first,
                    clef: score.clef,
                });
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
    const used = [...new Set(score.notes.filter((n) => !n.rest && n.drum != null).map((n) => n.drum))];
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
