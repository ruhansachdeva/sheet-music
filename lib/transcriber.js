// Picks a provider and runs a transcription through it.
//
// Set PROVIDER=gemini or PROVIDER=claude in .env to choose. With no PROVIDER,
// whichever key is present wins, so dropping a key in .env is enough.

import { TranscribeError } from "./errors.js";
import {
    RESPONSE_SCHEMA,
    SYSTEM_PROMPT,
    userPromptForRefine,
    userPromptForTranscribe,
} from "./prompt.js";
import * as claude from "./providers/claude.js";
import * as gemini from "./providers/gemini.js";

const PROVIDERS = { gemini, claude };

export { TranscribeError };

/** The provider in use, or null when no key is configured. */
export function currentProvider() {
    const chosen = (process.env.PROVIDER || "").toLowerCase();

    if (chosen) {
        const provider = PROVIDERS[chosen];
        if (!provider) {
            throw new TranscribeError(
                `Unknown PROVIDER "${chosen}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.`,
                500,
            );
        }
        return provider.available() ? provider : null;
    }

    return Object.values(PROVIDERS).find((provider) => provider.available()) ?? null;
}

/** Throws unless a provider is ready to be called. */
export function requireProvider() {
    const provider = currentProvider();
    if (provider) return provider;

    const chosen = (process.env.PROVIDER || "").toLowerCase();
    const missing = chosen
        ? `${PROVIDERS[chosen].keyName} is not set, but PROVIDER=${chosen}.`
        : `No API key is set (${Object.values(PROVIDERS)
              .map((p) => p.keyName)
              .join(" or ")}).`;

    throw new TranscribeError(
        `${missing} Copy .env.example to .env and add a key - see the README for how to get a free one.`,
        500,
    );
}

/** Reads the model's JSON reply, and checks it is actually a score. */
function parseResult(raw) {
    if (!raw.text) {
        throw new TranscribeError("The model returned an empty response.", 502);
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
            throw new TranscribeError("The model's response was not valid JSON.", 502);
        }
    }

    if (!parsed.musicxml?.includes("<score-partwise")) {
        throw new TranscribeError(
            "The model did not return a MusicXML score. The file may not be sheet music.",
            422,
        );
    }

    return {
        title: parsed.title || "Untitled",
        musicxml: parsed.musicxml,
        questions: Array.isArray(parsed.questions) ? parsed.questions : [],
        model: raw.model,
        // Why a lighter model answered instead of the usual one - "busy" or
        // "limit" - or false when the usual one did.
        fallback: raw.fallback || false,
        usage: raw.usage,
    };
}

/** First pass: a photo or PDF in, MusicXML plus any questions out. */
export async function transcribe({ file, instrument }) {
    const provider = requireProvider();
    const raw = await provider.generate({
        system: SYSTEM_PROMPT,
        text: userPromptForTranscribe(instrument),
        file,
        schema: RESPONSE_SCHEMA,
    });
    return parseResult(raw);
}

/** Second pass: the same file, the MusicXML so far, and my answers. */
export async function refine({ file, instrument, musicxml, answers }) {
    const provider = requireProvider();
    const raw = await provider.generate({
        system: SYSTEM_PROMPT,
        text: userPromptForRefine(instrument, musicxml, answers),
        file,
        schema: RESPONSE_SCHEMA,
    });
    return parseResult(raw);
}
