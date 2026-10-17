// Picks a provider and runs a transcription through it.
//
// Set PROVIDER=gemini or PROVIDER=claude in .env to choose. With no PROVIDER,
// whichever key is present wins, so dropping a key in .env is enough.

import { TranscribeError } from "./errors.js";
import * as read from "../public/js/reader/read.js";
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

/** First pass: a photo or PDF in, MusicXML plus any questions out. */
export function transcribe({ file, strips, instrument }) {
    return read.transcribe(requireProvider().generate, { file, strips, instrument, onContinue, onRecheck, onMissing });
}

/** Second pass: the same file, the MusicXML so far, and my answers. */
export function refine({ file, strips, instrument, musicxml, answers }) {
    return read.refine(requireProvider().generate, { file, strips, instrument, musicxml, answers, onContinue, onRecheck, onMissing });
}

function onContinue(bar) {
    console.log(`read: out of room after bar ${bar}, carrying on`);
}

function onMissing(bars) {
    console.log(`read: ${bars} bar(s) were skipped, asking for them`);
}

function onRecheck(bars) {
    console.log(`read: ${bars} bar(s) did not add up, rechecking them`);
}
