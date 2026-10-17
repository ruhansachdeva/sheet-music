// The two reading steps - a first read, and a correction from answers - for
// any `generate` function: a server provider, or the page's own Gemini client.
// Both take the prompt and the file, and both get the same checks on the way
// back, so a reading is held to one standard wherever it was made.

import { ReadError } from "./errors.js";
import {
    CONTINUATION_SCHEMA,
    RESPONSE_SCHEMA,
    SYSTEM_PROMPT,
    userPromptForContinuing,
    userPromptForRefine,
    userPromptForTranscribe,
} from "./prompt.js";

/**
 * How many times a reading that runs out of room is carried on. A dense page
 * of drums takes two or three answers; each is a request against the day's
 * allowance, so this stops a reading that never gets anywhere.
 */
const MAX_CONTINUATIONS = 4;

/**
 * First pass: a photo or PDF in, MusicXML plus any questions out.
 * `onContinue` hears the bar a reading picks up from, when it has to.
 */
export async function transcribe(generate, { file, instrument, onContinue }) {
    return parseResult(
        await complete(generate, {
            system: SYSTEM_PROMPT,
            text: userPromptForTranscribe(instrument),
            file,
            schema: RESPONSE_SCHEMA,
        }, onContinue),
    );
}

/** Second pass: the same file, the MusicXML so far, and the answers. */
export async function refine(generate, { file, instrument, musicxml, answers, onContinue }) {
    return parseResult(
        await complete(generate, {
            system: SYSTEM_PROMPT,
            text: userPromptForRefine(instrument, musicxml, answers),
            file,
            schema: RESPONSE_SCHEMA,
        }, onContinue),
    );
}

/**
 * Generates an answer, and if it runs out of room part-way through the score,
 * asks for the rest - as often as it takes - and returns the whole answer as
 * if it had come in one go. Every finished measure is kept; the model starts
 * again after the last of them.
 */
async function complete(generate, request, onContinue = () => {}) {
    const first = await generate(request);
    if (!first.incomplete) return first;

    let score = upToLastMeasure(partialField(first.text, "musicxml") ?? "");
    if (!score) throw tooLong();

    let fallback = first.fallback;
    let usage = first.usage;
    for (let round = 1; round <= MAX_CONTINUATIONS; round++) {
        const where = lastMeasure(score);
        onContinue(where.number);
        const next = await generate({
            ...request,
            text: userPromptForContinuing(request.text, score, where),
            schema: CONTINUATION_SCHEMA,
        });
        fallback ||= next.fallback;
        usage = added(usage, next.usage);

        if (next.incomplete) {
            const longer = join(score, upToLastMeasure(partialField(next.text, "rest") ?? ""));
            // Not one more measure: carrying on again would go no further.
            if (!longer || longer.length <= score.length) throw tooLong();
            score = longer;
            continue;
        }

        const rest = parseJson(next.text);
        const whole = typeof rest?.rest === "string" && join(score, rest.rest);
        if (!whole) throw new ReadError("The model lost its place carrying on with the score. Try again.", 502);
        return {
            text: JSON.stringify({
                title: partialField(first.text, "title"),
                musicxml: closed(whole),
                instrument: rest.instrument,
                questions: rest.questions,
            }),
            model: next.model,
            fallback,
            usage,
        };
    }
    throw tooLong();
}

function tooLong() {
    return new ReadError(
        "The score was too long to write out, even over several answers. Try reading it a page or " +
            "half a page at a time.",
        413,
    );
}

/**
 * A string field from JSON that was cut off part-way, as far as it got - or
 * the whole of it, if it was finished. Null if the field never started.
 */
export function partialField(json, key) {
    const start = new RegExp(`"${key}"\\s*:\\s*"`).exec(json ?? "");
    if (!start) return null;

    let out = "";
    for (let i = start.index + start[0].length; i < json.length; i++) {
        const c = json[i];
        if (c === '"') return out;
        if (c !== "\\") {
            out += c;
            continue;
        }
        const escaped = json[++i];
        if (escaped === undefined) break; // cut off mid-escape
        if (escaped === "u") {
            const hex = json.slice(i + 1, i + 5);
            if (!/^[\da-f]{4}$/i.test(hex)) break;
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 4;
        } else {
            out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[escaped] ?? escaped;
        }
    }
    return out;
}

/** The MusicXML up to the end of its last finished measure, or "". */
function upToLastMeasure(xml) {
    const end = xml.lastIndexOf("</measure>");
    return end < 0 ? "" : xml.slice(0, end + "</measure>".length);
}

/**
 * Where a score stops: the last measure's number, in which part (counting
 * from 1, and by id) of how many, and the measure numbers that part has.
 */
export function lastMeasure(xml) {
    const parts = [...xml.matchAll(/<part\s[^>]*\bid="([^"]*)"/g)];
    const numbers = [...xml.slice(parts.at(-1)?.index ?? 0).matchAll(/<measure\s[^>]*\bnumber="([^"]*)"/g)]
        .map((m) => m[1]);
    return {
        number: numbers.at(-1) ?? "",
        part: parts.length,
        partId: parts.at(-1)?.[1] ?? "",
        parts: (xml.match(/<score-part\s/g) ?? []).length,
        written: new Set(numbers),
    };
}

/**
 * The score so far with the rest of it added. The rest is meant to start
 * right after the last measure, but a model may repeat a measure or two, or
 * write the whole document out again: measures already there are dropped.
 * Null when the rest cannot be lined up with the score.
 */
export function join(score, rest) {
    let more = rest.trim();
    const { partId, written } = lastMeasure(score);

    if (more.includes("<score-partwise")) {
        const at = more.lastIndexOf(`<part id="${partId}"`);
        if (at < 0) return null;
        more = more.slice(more.indexOf(">", at) + 1).trim();
    }

    for (;;) {
        const measure = /^<measure\s[^>]*\bnumber="([^"]*)"/.exec(more);
        if (!measure || !written.has(measure[1])) break;
        const end = more.indexOf("</measure>");
        if (end < 0) return null;
        more = more.slice(end + "</measure>".length).trim();
    }

    // What comes next has to be a measure, or the end of the part.
    if (more && !/^<(measure[\s>]|\/part>)/.test(more)) return null;
    return score + more;
}

/** A score whose last answer forgot the closing tags gets them. */
function closed(xml) {
    if (xml.trimEnd().endsWith("</score-partwise>")) return xml;
    const open = /<part\s[^>]*>(?![\s\S]*<\/part>)/.test(xml);
    return `${xml}${open ? "</part>" : ""}</score-partwise>`;
}

function added(a = {}, b = {}) {
    const sum = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        sum[key] = (a[key] ?? 0) + (b[key] ?? 0);
    }
    return sum;
}

/** JSON from a model, which may wrap it in a code fence; null if it is not JSON. */
function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        // Some models wrap JSON in a code fence even when asked not to.
        const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
        try {
            return JSON.parse(fenced?.[1] ?? "");
        } catch {
            return null;
        }
    }
}

/** Reads the model's JSON reply, and checks it is actually a score. */
export function parseResult(raw) {
    if (!raw.text) {
        throw new ReadError("The model returned an empty response.", 502);
    }

    const parsed = parseJson(raw.text);
    if (!parsed) throw new ReadError("The model's response was not valid JSON.", 502);

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
