// What we ask the model for, and the shape we expect back. Nothing here is
// specific to a provider: both lib/providers/*.js send this same prompt.

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
        musicxml: {
            type: "string",
            description: "The complete MusicXML 3.1 score-partwise document.",
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
    required: ["title", "musicxml", "questions"],
    additionalProperties: false,
};

export const SYSTEM_PROMPT = `You read photographs and PDFs of sheet music and turn them into MusicXML.

Output a complete, valid MusicXML 3.1 \`score-partwise\` document:

- A full document: XML declaration, DOCTYPE, <score-partwise version="3.1">, <part-list> with a <score-part> per staff group, and one <part> per score-part.
- <attributes> in the first measure with <divisions>, <key>, <time> and a <clef> per staff. Pick divisions that make every duration in the piece a whole number (480 is a safe default; it divides into triplets, sixteenths and dotted notes).
- Tempo as <direction> with <sound tempo="..."/> and a <metronome> display, taken from the score's marking. The <metronome> shows the mark as printed - its <beat-unit>, any <beat-unit-dot/>, and <per-minute>. <sound tempo> is ALWAYS quarter notes per minute, so convert: dotted quarter = 60 is tempo 90, half = 60 is tempo 120, eighth = 120 is tempo 60. If the score has no tempo marking, leave the tempo out rather than inventing one.
- Every measure's durations must add up to the time signature, in every voice. Check each measure before moving on: sum the <duration> values per voice and compare against divisions × beats. This is the most common mistake - if a measure does not add up, you have misread a note, a dot or a rest.
- Rests as <rest/> notes with real durations, never as gaps.
- Dotted notes with <dot/> as well as the matching <duration>.
- Ties with BOTH <tie type="start"/> or <tie type="stop"/> inside <note>, and <tied type="start"/> or <tied type="stop"/> inside <notations>. Tied notes must have identical pitch.
- Tuplets with <time-modification> (<actual-notes>, <normal-notes>) on every note in the tuplet, plus <notations><tuplet type="start"/></notations> on the first and <tuplet type="stop"/> on the last. A triplet of eighths in 4/4 with divisions=480 is three notes of duration 160.
- Chords: the first note of a chord is a plain note, every other note in it carries <chord/>.
- Multiple voices and staves: <staves> in <attributes>, a <voice> and <staff> element in every note, and <backup> between voices. Piano is two staves, treble on staff 1 and bass on staff 2, usually voice 1 and voice 2.
- Repeats as <barline> with <bar-style>, <repeat direction="forward"/> or <repeat direction="backward"/>, and endings as <ending> when the score shows them.
- Drums and other unpitched percussion: a <score-instrument> plus <midi-instrument> per kit piece, with <midi-channel>10</midi-channel> and the General MIDI <midi-unpitched> number (counting from 1, so the bass drum is 37), notes written as <unpitched> with <display-step> and <display-octave>, and an <instrument> reference on every note.
- Pitches at WRITTEN pitch, exactly as printed on the page. Do not transpose to concert pitch - the player handles that.
- Dynamics, articulations, slurs and beams where you can read them.

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
 * The proofreading pass: the page again, with the first transcription, and an
 * instruction to check it rather than write it. Reading a note off the staff
 * and checking a note already written are different jobs, and the second
 * catches what the first gets wrong - a chord read one line too high, a chord
 * tone dropped.
 */
export function userPromptForProofread(instrument, musicxml) {
    return `Below is a MusicXML transcription of this sheet music (instrument: ${instrument}). Proofread it against the page and return a corrected version.

Go through it measure by measure, staff by staff, and for every note:

1. Find its notehead on the page. Decide whether it sits ON a line or IN a space, and count from the clef's anchor to name the pitch. Do not trust the pitch already written - check it.
2. For a chord, check that every notehead on the page is in the transcription, and none is there that is not on the page. A stacked chord is all on lines or all in spaces; if the written pitches mix the two, one of them is wrong.
3. Check accidentals: those printed on the page, and those implied by the key signature or by an earlier accidental in the same measure.
4. Check the rhythm: note values, dots, ties, tuplets and rests, and that every measure still adds up to its time signature in every voice.

Then return the whole score with everything you found fixed. If the transcription was already right, return it unchanged. Keep the title. Only ask a question if the page itself is genuinely ambiguous; usually return an empty list.

The transcription to check:

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
