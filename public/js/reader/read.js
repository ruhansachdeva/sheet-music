// The two reading steps - a first read, and a correction from answers - for
// any `generate` function: a server provider, or the page's own Gemini client.
// Both take the prompt and the file, and both get the same checks on the way
// back, so a reading is held to one standard wherever it was made.

import { ReadError } from "./errors.js";
import {
    RESPONSE_SCHEMA,
    SYSTEM_PROMPT,
    userPromptForRefine,
    userPromptForTranscribe,
} from "./prompt.js";

/** First pass: a photo or PDF in, MusicXML plus any questions out. */
export async function transcribe(generate, { file, instrument }) {
    return parseResult(
        await generate({
            system: SYSTEM_PROMPT,
            text: userPromptForTranscribe(instrument),
            file,
            schema: RESPONSE_SCHEMA,
        }),
    );
}

/** Second pass: the same file, the MusicXML so far, and the answers. */
export async function refine(generate, { file, instrument, musicxml, answers }) {
    return parseResult(
        await generate({
            system: SYSTEM_PROMPT,
            text: userPromptForRefine(instrument, musicxml, answers),
            file,
            schema: RESPONSE_SCHEMA,
        }),
    );
}

/** Reads the model's JSON reply, and checks it is actually a score. */
export function parseResult(raw) {
    if (!raw.text) {
        throw new ReadError("The model returned an empty response.", 502);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw.text);
    } catch {
        // Some models wrap JSON in a code fence even when asked not to.
        const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw.text);
        try {
            parsed = JSON.parse(fenced?.[1] ?? "");
        } catch {
            throw new ReadError("The model's response was not valid JSON.", 502);
        }
    }

    if (!parsed.musicxml?.includes("<score-partwise")) {
        throw new ReadError(
            "The model did not return a MusicXML score. The file may not be sheet music.",
            422,
        );
    }

    return {
        title: parsed.title || "Untitled",
        musicxml: parsed.musicxml,
        // What the page looks written for, as the model read it.
        instrument: typeof parsed.instrument === "string" ? parsed.instrument : "unknown",
        questions: Array.isArray(parsed.questions) ? parsed.questions : [],
        model: raw.model,
        // Why a lighter model answered instead of the usual one - "busy" or
        // "limit" - or false when the usual one did.
        fallback: raw.fallback || false,
        usage: raw.usage,
    };
}
