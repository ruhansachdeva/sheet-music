import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";

/** Beta that enables server-side refusal fallbacks in their `"default"` form. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** MusicXML can run to tens of thousands of tokens, so give the model room. */
const MAX_TOKENS = 64000;

/**
 * Strict schema for the response. The same shape comes back from the first
 * transcription and from every correction round, so the browser has one format
 * to handle.
 */
const RESPONSE_SCHEMA = {
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

const SYSTEM_PROMPT = `You read photographs and PDFs of sheet music and turn them into MusicXML.

Output a complete, valid MusicXML 3.1 \`score-partwise\` document:

- A full document: XML declaration, DOCTYPE, <score-partwise version="3.1">, <part-list> with a <score-part> per staff group, and one <part> per score-part.
- <attributes> in the first measure with <divisions>, <key>, <time> and a <clef> per staff. Pick divisions that make every duration in the piece a whole number (480 is a safe default; it divides into triplets, sixteenths and dotted notes).
- Tempo as <direction> with <sound tempo="..."/> and a <metronome> display, taken from the score's marking. If the score has no tempo marking, leave the tempo out rather than inventing one.
- Every measure's durations must add up to the time signature, in every voice. Check each measure before moving on: sum the <duration> values per voice and compare against divisions × beats. This is the most common mistake - if a measure does not add up, you have misread a note, a dot or a rest.
- Rests as <rest/> notes with real durations, never as gaps.
- Dotted notes with <dot/> as well as the matching <duration>.
- Ties with BOTH <tie type="start"/> or <tie type="stop"/> inside <note>, and <tied type="start"/> or <tied type="stop"/> inside <notations>. Tied notes must have identical pitch.
- Tuplets with <time-modification> (<actual-notes>, <normal-notes>) on every note in the tuplet, plus <notations><tuplet type="start"/></notations> on the first and <tuplet type="stop"/> on the last. A triplet of eighths in 4/4 with divisions=480 is three notes of duration 160.
- Chords: the first note of a chord is a plain note, every other note in it carries <chord/>.
- Multiple voices and staves: <staves> in <attributes>, a <voice> and <staff> element in every note, and <backup> between voices. Piano is two staves, treble on staff 1 and bass on staff 2, usually voice 1 and voice 2.
- Repeats as <barline> with <bar-style>, <repeat direction="forward"/> or <repeat direction="backward"/>, and endings as <ending> when the score shows them.
- Pitches at WRITTEN pitch, exactly as printed on the page. Do not transpose to concert pitch - the player handles that.
- Dynamics, articulations, slurs and beams where you can read them.

Ask a clarifying question only when the source is genuinely ambiguous and the answer changes the notes or the timing. Good reasons to ask:

- A curved line that could be a tie or a slur.
- An accidental that could be a sharp or a natural, or that could belong to a different note.
- A measure whose rhythm does not add up, where more than one reading is plausible.
- A smudged, cropped or obscured passage.
- An unclear clef, key signature or time signature.

Do not ask about things you can read, about stylistic choices, about dynamics or articulation, or about anything that does not change the notes or the timing. If a reading is clearly most likely, use it and stay quiet. Zero questions is the normal case for a clean, legible score.

Always produce your best-guess MusicXML for the whole piece, even when you have questions - the questions refine a score that already plays.`;

function userPromptForTranscribe(instrument) {
    return `Read this sheet music and transcribe it to MusicXML.

The player will play it back as: ${instrument}. Use that to read the score - it tells you which clef and range to expect, and whether two staves belong to one player (piano) or one staff is the whole part.

Transcribe every measure of every staff you can see. Write the notes at written pitch, as printed.`;
}

function userPromptForRefine(instrument, musicxml, answers) {
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

/** Image and PDF files become the content block type Claude expects for each. */
function sourceBlock(file) {
    const data = file.buffer.toString("base64");

    if (file.mimetype === "application/pdf") {
        return {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data },
        };
    }

    return {
        type: "image",
        source: { type: "base64", media_type: file.mimetype, data },
    };
}

async function callClaude(content) {
    const client = new Anthropic();

    // Streamed, because a full score of MusicXML takes a while to generate and
    // a non-streaming request would hit the SDK's HTTP timeout.
    const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: {
            effort: "high",
            format: { type: "json_schema", schema: RESPONSE_SCHEMA },
        },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
        const why = message.stop_details?.explanation ?? "no explanation given";
        throw new TranscribeError(`Claude declined to read this file (${why}).`, 422);
    }

    if (message.stop_reason === "max_tokens") {
        throw new TranscribeError(
            "The score was too long to transcribe in one go. Try a single page or a tighter crop.",
            413,
        );
    }

    const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

    if (!text) {
        throw new TranscribeError("Claude returned an empty response.", 502);
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new TranscribeError("Claude's response was not valid JSON.", 502);
    }

    if (!parsed.musicxml?.includes("<score-partwise")) {
        throw new TranscribeError(
            "Claude did not return a MusicXML score. The file may not be sheet music.",
            422,
        );
    }

    return {
        title: parsed.title || "Untitled",
        musicxml: parsed.musicxml,
        questions: Array.isArray(parsed.questions) ? parsed.questions : [],
        usage: message.usage,
    };
}

export class TranscribeError extends Error {
    constructor(message, status = 500) {
        super(message);
        this.status = status;
    }
}

/** First pass: a photo or PDF in, MusicXML plus any questions out. */
export function transcribe({ file, instrument }) {
    return callClaude([sourceBlock(file), { type: "text", text: userPromptForTranscribe(instrument) }]);
}

/** Second pass: the same file, the MusicXML so far, and my answers. */
export function refine({ file, instrument, musicxml, answers }) {
    return callClaude([
        sourceBlock(file),
        { type: "text", text: userPromptForRefine(instrument, musicxml, answers) },
    ]);
}
