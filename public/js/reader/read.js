// The two reading steps - a first read, and a correction from answers - for
// any `generate` function: a server provider, or the page's own Gemini client.
// Both take the prompt and the file, and both get the same checks on the way
// back, so a reading is held to one standard wherever it was made.

import { ReadError } from "./errors.js";
import { checkMeasures, missingMeasures } from "./measures.js";
import {
    CONTINUATION_SCHEMA,
    RECHECK_SCHEMA,
    RESPONSE_SCHEMA,
    SYSTEM_PROMPT,
    aboutStrips,
    userPromptForContinuing,
    userPromptForMissing,
    userPromptForRecheck,
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
 * `onContinue` hears the bar a reading picks up from, when it has to, and
 * `onRecheck` how many bars are being looked at again.
 */
export async function transcribe(generate, { file, strips, instrument, onContinue, onRecheck, onMissing }) {
    const first = parseResult(
        await complete(generate, {
            system: SYSTEM_PROMPT,
            text: userPromptForTranscribe(instrument) + seen(strips),
            file,
            strips,
            schema: RESPONSE_SCHEMA,
        }, onContinue),
    );
    const whole = await fillMissing(generate, first, { file, strips, instrument, onMissing });
    return recheck(generate, whole, { file, strips, instrument, onRecheck });
}

/** Second pass: the same file, the MusicXML so far, and the answers. */
export async function refine(generate, { file, strips, instrument, musicxml, answers, onContinue, onRecheck, onMissing }) {
    const corrected = parseResult(
        await complete(generate, {
            system: SYSTEM_PROMPT,
            text: userPromptForRefine(instrument, musicxml, answers) + seen(strips),
            file,
            strips,
            schema: RESPONSE_SCHEMA,
        }, onContinue),
    );
    const whole = await fillMissing(generate, corrected, { file, strips, instrument, onMissing });
    return recheck(generate, whole, { file, strips, instrument, onRecheck });
}

/** What to say about how the page is sent: nothing, unless it is in strips. */
function seen(strips) {
    return strips?.length ? aboutStrips(strips.length) : "";
}

/**
 * Bars a reading skipped - a run of bar numbers missing, such as a whole
 * strip of the page - are asked for, and each one put in its place. If that
 * fails, the reading stands; the bars still missing are not hidden, since
 * the score's numbering shows the gap.
 */
async function fillMissing(generate, result, { file, strips, instrument, onMissing = () => {} }) {
    const missing = missingMeasures(result.musicxml);
    if (!missing.length) return result;
    const wanted = new Set(missing.flatMap(({ part, numbers }) => numbers.map((n) => `${part}\n${n}`)));
    onMissing(wanted.size);

    let musicxml = result.musicxml;
    let usage = result.usage;
    try {
        const answer = await generate({
            system: SYSTEM_PROMPT,
            text: userPromptForMissing(instrument, musicxml, missing) + seen(strips),
            file,
            strips,
            schema: RECHECK_SCHEMA,
        });
        usage = added(usage, answer.usage);
        const measures = answer.incomplete ? [] : parseJson(answer.text)?.measures ?? [];
        // In number order, so each lands after the ones before it.
        const sorted = (Array.isArray(measures) ? measures : [])
            .filter(({ part, number }) => wanted.has(`${part}\n${number}`))
            .sort((a, b) => Number(a.number) - Number(b.number));
        for (const { part, number, musicxml: measure } of sorted) {
            musicxml = insertMeasure(musicxml, part, String(number), measure) ?? musicxml;
        }
    } catch {
        // Kept as read.
    }
    return { ...result, musicxml, usage };
}

/**
 * The score with a measure put into a part, before the first one numbered
 * after it. A measure that becomes the part's first gets the <attributes> the
 * old first one had, if it came without any. Null if it cannot go in.
 */
function insertMeasure(xml, part, number, measure) {
    let fresh = String(measure ?? "").trim();
    const opening = /^<measure\s[^>]*\bnumber="([^"]*)"[^>]*>/.exec(fresh);
    if (!opening || opening[1] !== number || !fresh.endsWith("</measure>")) return null;

    const partOpen = new RegExp(`<part\\s[^>]*\\bid="${escaped(part)}"[^>]*>`).exec(xml);
    if (!partOpen) return null;
    const bodyStart = partOpen.index + partOpen[0].length;
    const bodyEnd = xml.indexOf("</part>", bodyStart);
    if (bodyEnd < 0) return null;

    const measures = [...xml.slice(bodyStart, bodyEnd).matchAll(/<measure\s[^>]*\bnumber="([^"]*)"[^>]*>/g)];
    const next = measures.find((m) => Number(m[1]) > Number(number));
    const at = next ? bodyStart + next.index : bodyEnd;

    if (next === measures[0] && next && !fresh.includes("<attributes>")) {
        const attributes = /<attributes>[\s\S]*?<\/attributes>/.exec(xml.slice(at, bodyEnd))?.[0];
        if (attributes) fresh = fresh.replace(opening[0], opening[0] + attributes);
    }
    return xml.slice(0, at) + fresh + xml.slice(at);
}

/**
 * A measure that does not add up is always misread, and how carefully the
 * model checks its own work varies a lot from one read to the next. So the
 * reading is checked here, and the model is shown just the measures that are
 * off - with what each totals and needs - and asked to look again. Each
 * corrected measure that now adds up takes the place of the old one. The
 * result says which bars are still off, by number. If the recheck itself
 * fails, the reading stands as it was: it is still the best there is.
 */
async function recheck(generate, result, { file, strips, instrument, onRecheck = () => {} }) {
    const { uneven } = checkMeasures(result.musicxml);
    if (!uneven.length) return { ...result, uneven: [], missing: skipped(result.musicxml) };

    const key = (part, measure) => `${part}\n${measure}`;
    const asked = new Set(uneven.map((u) => key(u.part, u.measure)));
    onRecheck(asked.size);

    let musicxml = result.musicxml;
    let usage = result.usage;
    try {
        const answer = await generate({
            system: SYSTEM_PROMPT,
            text: userPromptForRecheck(instrument, musicxml, uneven) + seen(strips),
            file,
            strips,
            schema: RECHECK_SCHEMA,
        });
        usage = added(usage, answer.usage);
        const corrections = answer.incomplete ? [] : parseJson(answer.text)?.measures ?? [];
        for (const { part, number: given, musicxml: measure } of Array.isArray(corrections) ? corrections : []) {
            const number = String(given);
            if (!asked.has(key(part, number))) continue;
            const replaced = replaceMeasure(musicxml, part, number, measure);
            if (replaced && fewerUneven(replaced, musicxml, key(part, number))) musicxml = replaced;
        }
    } catch {
        // Kept as read: the recheck only ever improves on it.
    }

    const still = checkMeasures(musicxml).uneven;
    return { ...result, musicxml, usage, uneven: [...new Set(still.map((u) => u.measure))], missing: skipped(musicxml) };
}

/** The bar numbers still missing from a score, in any part. */
function skipped(xml) {
    return [...new Set(missingMeasures(xml).flatMap(({ numbers }) => numbers))].sort((a, b) => a - b);
}

/**
 * Whether a measure, replaced, now adds up - without making any other
 * measure stop adding up, as a lost <divisions> or time signature would.
 */
function fewerUneven(after, before, which) {
    const off = (xml) => new Set(checkMeasures(xml).uneven.map((u) => `${u.part}\n${u.measure}`));
    const was = off(before);
    const now = off(after);
    return !now.has(which) && [...now].every((bar) => was.has(bar));
}

/** The score with one measure of one part swapped for another, or null. */
function replaceMeasure(xml, part, number, measure) {
    const fresh = String(measure ?? "").trim();
    const opening = /^<measure\s[^>]*\bnumber="([^"]*)"[^>]*>/.exec(fresh);
    if (!opening || opening[1] !== number || !fresh.endsWith("</measure>")) return null;

    const partAt = xml.search(new RegExp(`<part\\s[^>]*\\bid="${escaped(part)}"`));
    if (partAt < 0) return null;
    const partEnd = xml.indexOf("</part>", partAt);
    const start = new RegExp(`<measure\\s[^>]*\\bnumber="${escaped(number)}"[^>]*>`, "g");
    start.lastIndex = partAt;
    const found = start.exec(xml);
    if (!found || (partEnd >= 0 && found.index > partEnd)) return null;
    const end = xml.indexOf("</measure>", found.index);
    if (end < 0) return null;
    return xml.slice(0, found.index) + fresh + xml.slice(end + "</measure>".length);
}

function escaped(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
