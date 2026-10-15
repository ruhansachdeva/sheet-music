// Picks a provider and runs a transcription through it.
//
// Set PROVIDER=gemini or PROVIDER=claude in .env to choose. With no PROVIDER,
// whichever key is present wins, so dropping a key in .env is enough.

import { TranscribeError } from "./errors.js";
import {
    RESPONSE_SCHEMA,
    SYSTEM_PROMPT,
    userPromptForProofread,
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
    const first = parseResult(raw);

    // A second pass that checks the first against the page. It roughly doubles
    // the time a read takes, which is the trade asked for: correct over fast.
    // PROOFREAD=0 in .env turns it off.
    if (process.env.PROOFREAD === "0") return first;

    try {
        const checked = parseResult(
            await provider.generate({
                system: SYSTEM_PROMPT,
                text: userPromptForProofread(instrument, first.musicxml),
                file,
                schema: RESPONSE_SCHEMA,
            }),
        );
        // A lighter model checking the usual one's work would make it worse,
        // not better: if the check fell back to one, keep the first read.
        if (checked.fallback && !first.fallback) {
            console.log("proofread fell back to a lighter model, keeping the first read");
            return { ...first, proofread: false };
        }
        return {
            ...checked,
            title: checked.title || first.title,
            proofread: true,
            usage: sumUsage(first.usage, checked.usage),
        };
    } catch (error) {
        // The first read is a perfectly good score; a failed check of it
        // should not throw it away.
        console.error(`proofread failed, keeping the first read: ${error.message}`);
        return { ...first, proofread: false };
    }
}

function sumUsage(a = {}, b = {}) {
    return { input: (a.input ?? 0) + (b.input ?? 0), output: (a.output ?? 0) + (b.output ?? 0) };
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
