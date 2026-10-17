import { INSTRUMENTS } from "../instruments.js";

// What we ask the model for, and the shape we expect back. Nothing here is
// specific to a provider, or to where the reading runs: the server's
// providers and the page itself (reading with your own key) send this same
// prompt.

/**
 * The response shape, as a strict JSON schema. The same shape comes back from
 * the first transcription and from every correction round, so the browser has
 * one format to handle.
 */
export const RESPONSE_SCHEMA = {
    type: "object",
    properties: {
        title: {
            type: "string",
            description: "The title of the piece, or a short description if the score has no title.",
        },
        bars: {
            type: "integer",
            description:
                "The number of the score's last bar, worked out before writing any MusicXML: the bar " +
                "number printed at the start of the last system, plus the bars after it in that system " +
                "(counting every page, if there are several).",
        },
        musicxml: {
            type: "string",
            description: "The complete MusicXML 3.1 score-partwise document.",
        },
        instrument: {
            type: "string",
            enum: [...Object.keys(INSTRUMENTS), "unknown"],
            description:
                "The instrument the music on the page is written for - from a part name, the clef " +
                "and range, or the notation itself - or unknown when the page does not make it clear.",
        },
        questions: {
            type: "array",
            description:
                "Clarifying questions, only for things that are genuinely ambiguous in the source. Empty when nothing is unclear.",
            items: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Short stable id, e.g. q1." },
                    measure: { type: "integer", description: "Measure number the question is about." },
                    question: { type: "string", description: "The question, in one sentence." },
                    options: {
                        type: "array",
                        description: "Two to four concrete answers to choose from.",
                        items: { type: "string" },
                    },
                },
                required: ["id", "measure", "question", "options"],
                additionalProperties: false,
            },
        },
    },
    required: ["title", "bars", "musicxml", "instrument", "questions"],
    additionalProperties: false,
};

/**
 * The shape of an answer that carries on with a score where the last one ran
 * out of room: the rest of the document, and the same instrument and
 * questions, now that the whole page has been read.
 */
export const CONTINUATION_SCHEMA = {
    type: "object",
    properties: {
        rest: {
            type: "string",
            description:
                "The rest of the MusicXML document: everything after the last </measure> of the score " +
                "so far, through the closing </score-partwise>.",
        },
        instrument: RESPONSE_SCHEMA.properties.instrument,
        questions: RESPONSE_SCHEMA.properties.questions,
    },
    required: ["rest", "instrument", "questions"],
    additionalProperties: false,
};

/**
 * The shape of an answer to a recheck: only the measures asked about, each
 * corrected in full, to be put back in place of the ones that did not add up.
 */
export const RECHECK_SCHEMA = {
    type: "object",
    properties: {
        measures: {
            type: "array",
            description: "Each measure that was asked for, in full.",
            items: {
                type: "object",
                properties: {
                    part: { type: "string", description: "The id of the part the measure is in, e.g. P1." },
                    number: { type: "string", description: "The measure's number attribute, as in the score." },
                    musicxml: {
                        type: "string",
                        description: "The whole corrected <measure> element, from <measure ...> to </measure>.",
                    },
                },
                required: ["part", "number", "musicxml"],
                additionalProperties: false,
            },
        },
    },
    required: ["measures"],
    additionalProperties: false,
};

export const SYSTEM_PROMPT = `You read photographs and PDFs of sheet music and turn them into MusicXML.

Output a complete, valid MusicXML 3.1 \`score-partwise\` document:

- A full document: XML declaration, DOCTYPE, <score-partwise version="3.1">, <part-list> with a <score-part> per staff group, and one <part> per score-part.
- Compact, because the whole score has to fit in one answer: no indentation, line breaks or comments between elements, and nothing that only shapes the printed page - no <identification>, <defaults>, <credit>, <print>, <stem> or <beam>, and no default-x or other position attributes. The player lays out, stems and beams the music itself.
- <attributes> in the first measure with <divisions>, <key>, <time> and a <clef> per staff. Pick divisions that make every duration in the piece a whole number (480 is a safe default; it divides into triplets, sixteenths and dotted notes).
- Tempo as <direction> with <sound tempo="..."/> and a <metronome> display, taken from the score's marking. The <metronome> shows the mark as printed - its <beat-unit>, any <beat-unit-dot/>, and <per-minute>. <sound tempo> is ALWAYS quarter notes per minute, so convert: dotted quarter = 60 is tempo 90, half = 60 is tempo 120, eighth = 120 is tempo 60. If the score has no tempo marking, leave the tempo out rather than inventing one.
- Every measure's durations must add up to the time signature, in every voice. Check each measure before moving on: sum the <duration> values per voice and compare against divisions × beats. This is the most common mistake - if a measure does not add up, you have misread a note, a dot or a rest.
- Measures numbered 1, 2, 3… in order from the first bar on the page (a pickup bar before the first full bar is number 0, with implicit="yes"). Where bar numbers are printed at the start of systems, use them to check you have not skipped or doubled a bar.
- Rests as <rest/> notes with real durations, never as gaps.
- Dotted notes with <dot/> as well as the matching <duration>.
- Ties with BOTH <tie type="start"/> or <tie type="stop"/> inside <note>, and <tied type="start"/> or <tied type="stop"/> inside <notations>. Tied notes must have identical pitch.
- Tuplets with <time-modification> (<actual-notes>, <normal-notes>) on every note in the tuplet, plus <notations><tuplet type="start"/></notations> on the first and <tuplet type="stop"/> on the last. A triplet of eighths in 4/4 with divisions=480 is three notes of duration 160.
- Chords: the first note of a chord is a plain note, every other note in it carries <chord/>.
- Multiple voices and staves: <staves> in <attributes>, a <voice> and <staff> element in every note, and <backup> between voices. Piano is two staves, treble on staff 1 and bass on staff 2, usually voice 1 and voice 2.
- Repeats as <barline> with <bar-style>, <repeat direction="forward"/> or <repeat direction="backward"/>, and endings as <ending> when the score shows them.
- A measure-repeat sign - a slash between two dots filling the bar - means the bar before is played again: write that bar's notes out again in full, exactly the same.
- Drums and other unpitched percussion: a <score-instrument> plus <midi-instrument> per kit piece, with <midi-channel>10</midi-channel> and the General MIDI <midi-unpitched> number (counting from 1, so the bass drum is 37), notes written as <unpitched> with <display-step> and <display-octave>, and an <instrument> reference on every note.
- A drum staff is read by where each note sits, and its notehead. Unless the page has a legend saying otherwise, the usual layout is: bass drum in the bottom space (F4); snare in the third space (C5); toms at E5, D5 and B4, high to low, and floor tom at A4 or G4; hi-hat as an x just above the top line (G5), open when it has a small circle over it; ride as an x on the top line (F5); crash as an x on the ledger line above (A5); hi-hat pedal as an x below the staff (D4). Everything on one stem is hit together, one note each in a chord. A small slashed note just before another is a flam: a grace note.
- Pitches at WRITTEN pitch, exactly as printed on the page. Do not transpose to concert pitch - the player handles that.
- Dynamics, articulations and slurs where you can read them.

Say which instrument the page is written for in \`instrument\`, separately from the instrument it will be played on, which the user gives you. Read it from the page: a part name ("Clarinet in B♭"), the clef and range, or the notation - a percussion clef with x noteheads is a drum kit. Say unknown when the page does not make it clear. Transcribe what is printed either way: if drum notation is played back on a flute, it is still drum notation.

Ask a clarifying question only when the source is genuinely ambiguous and the answer changes the notes or the timing. Good reasons to ask:

- A curved line that could be a tie or a slur.
- An accidental that could be a sharp or a natural, or that could belong to a different note.
- A measure whose rhythm does not add up, where more than one reading is plausible.
- A smudged, cropped or obscured passage.
- An unclear clef, key signature or time signature.

Do not ask about things you can read, about stylistic choices, about dynamics or articulation, or about anything that does not change the notes or the timing. If a reading is clearly most likely, use it and stay quiet. Zero questions is the normal case for a clean, legible score.

Always produce your best-guess MusicXML for the whole piece, even when you have questions - the questions refine a score that already plays.

Reply with JSON matching the required schema, and nothing else.`;

export function userPromptForTranscribe(instrument) {
    return `Read this sheet music and transcribe it to MusicXML.

The player will play it back as: ${instrument}. Use that to read the score - it tells you which clef and range to expect, and whether two staves belong to one player (piano) or one staff is the whole part.

Transcribe every measure of every staff you can see. Write the notes at written pitch, as printed.`;
}

/**
 * Carrying on with an answer that ran out of room. `task` is what was asked;
 * `sofar` is the score up to its last finished measure; `where` is from
 * read.js's lastMeasure.
 */
export function userPromptForContinuing(task, sofar, where, bars) {
    const place = where.parts > 1 ? `measure ${where.number} of part ${where.part} of ${where.parts}` : `measure ${where.number}`;
    const after = where.parts > where.part
        ? "the measures after it, then </part> and the parts still to come"
        : "the measures after it, then </part>";

    const end = Number.isInteger(bars) && bars > 0 ? ` The score runs to bar ${bars}, so there is more to write.` : "";
    return `${task}

You have started this answer already, but it ran out of room part-way through the MusicXML. Here is the score as far as it got. It stops after ${place}.${end}

${sofar}

Carry on from exactly where it stops. In \`rest\`, write only what comes after that last </measure>: ${after}, through </score-partwise>. Do not repeat anything already written. Keep to the same divisions, instrument ids, voices and compact style. If that part is already finished, \`rest\` starts with </part>.

Give \`instrument\` and \`questions\` for the whole page, as you would have at the end of the first answer.`;
}

/**
 * Asking again about the measures that do not add up. `uneven` is from
 * measures.js: one entry per voice that is off.
 */
export function userPromptForRecheck(instrument, musicxml, uneven) {
    const parts = new Set(uneven.map((u) => u.part));
    const lines = uneven
        .map((u) =>
            `- Measure ${u.measure}${parts.size > 1 ? ` of part ${u.part}` : ""}, voice ${u.voice}: ` +
            `its durations total ${u.total}, but the time signature needs ${u.expected}.`)
        .join("\n");

    return `Here is the MusicXML you produced for this sheet music (instrument: ${instrument}). These measures do not add up:

${lines}

A measure that does not add up has a misread note, dot, rest or tuplet in it. Look at each of these measures on the page again, note by note, and correct it so that every voice adds up - dotted notes, sixteenths and tuplets are the usual culprits. Keep everything else in the measure (attributes, directions, barlines) as it is.

Return only these measures, each as its whole corrected <measure> element, in the same compact style, with its part id and number. Do not return the rest of the score.

The current MusicXML:

${musicxml}`;
}

/** Said alongside music sent as strips, so they are read as one score. */
export function aboutStrips(count) {
    return `\n\nThe music comes as ${count} images, in reading order: slices cut between systems (and between pages, if it has several), so each can be seen in detail. Together they are the whole score, and the bars run on from one image to the next. Start with the first image - it holds the top of the first page and bar 1 - and read every image; none of them is only a title.`;
}

/**
 * Asking for bars a reading skipped. `missing` is from measures.js:
 * [{ part, numbers }].
 */
export function userPromptForMissing(instrument, musicxml, missing) {
    const span = (numbers) => {
        const runs = [];
        for (const n of numbers) {
            const run = runs.at(-1);
            if (run && n === run[1] + 1) run[1] = n;
            else runs.push([n, n]);
        }
        return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
    };
    const lines = missing
        .map(({ part, numbers }) => `- ${missing.length > 1 ? `Part ${part}: ` : ""}measures ${span(numbers)}`)
        .join("\n");

    return `Here is the MusicXML you produced for this sheet music (instrument: ${instrument}). It skips some measures:

${lines}

Read these measures from the page - check the bar numbers printed at the start of each system to find them - and write each one as a whole <measure> element, in the same compact style, with its part id and number. The first measure of a part carries the <attributes> (divisions, key, time and clef) and any tempo marking. Keep to the same divisions, instrument ids and voices as the rest of the score. Return only these measures.

The MusicXML so far:

${musicxml}`;
}

/**
 * Looking again at bars the player says were read wrong. `numbers` are the
 * bar numbers, as strings.
 */
export function userPromptForReread(instrument, musicxml, numbers) {
    const one = numbers.length === 1;
    const which = one ? `measure ${numbers[0]}` : `measures ${numbers.join(", ")}`;
    return `Here is the MusicXML you produced for this sheet music (instrument: ${instrument}). Playing it back, I found ${which} read wrong.

Look at ${one ? "that measure" : "those measures"} on the page again - find ${one ? "it" : "them"} by the bar numbers printed at the start of each system - and read note by note: each notehead's line or space and its shape (an x is a different note from a round head), every note stacked on a stem, accidentals, dots, ties, rests and tuplets. Do not assume your first reading was right; it was not.

Write each as its whole corrected <measure> element, in the same compact style, with its part id and number, keeping its attributes, directions and barlines. Return only ${one ? "this measure" : "these measures"}, in every part that has ${one ? "it" : "them"}.

The current MusicXML:

${musicxml}`;
}

export function userPromptForRefine(instrument, musicxml, answers) {
    const answerLines = answers
        .map((a) => `- ${a.question}\n  My answer: ${a.answer}`)
        .join("\n");

    return `Here is the MusicXML you produced for this sheet music (instrument: ${instrument}), and my answers to your questions.

My answers:
${answerLines}

Apply the answers to the MusicXML and return the corrected score. Rules:

- Change only what the answers affect, plus anything that has to change to stay consistent (a tie that becomes a slur, a measure that now has to add up differently).
- Re-check the affected measures: durations must still add up to the time signature in every voice.
- Where I skipped a question, keep your best guess and do not ask it again.
- Only ask a new question if an answer opened up a genuinely new ambiguity. Usually return an empty questions list.

The current MusicXML:

${musicxml}`;
}
