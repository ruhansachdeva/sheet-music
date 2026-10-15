// Google Gemini provider, over the REST Interactions API - no extra dependency.
//
// Gemini's free tier covers the Flash models, which take both images and PDFs
// (PDFs natively, up to 1000 pages), so a scan does not have to be rendered to
// images first.

import { Agent, fetch } from "undici";
import { TranscribeError } from "../errors.js";

/**
 * How long a read may take. The request is not streamed, so Google sends no
 * response headers until the whole score is written - and Node's built-in
 * fetch gives up after 300 seconds without headers. Reads have been measured
 * at 80-216 seconds, and a dense page or a busy free tier goes past 300, at
 * which point a request that would have succeeded was being abandoned.
 */
const READ_TIMEOUT_MS = 15 * 60 * 1000;
const patient = new Agent({ headersTimeout: READ_TIMEOUT_MS, bodyTimeout: READ_TIMEOUT_MS });

// GEMINI_API_BASE points at a proxy - or, in tools/provider-test.mjs, a fake.
const API_BASE = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";
const ENDPOINT = `${API_BASE}/interactions`;
const MODELS_ENDPOINT = `${API_BASE}/models`;

/**
 * An alias, not a pinned version: it follows the current Flash model, and the
 * pinned ones go through spells of being too busy to answer.
 *
 * Flash only. Flash-Lite used to stand in when Flash was busy, but measured on
 * the accuracy samples it got 0-14% of pitches right, against about 90% for
 * Flash - a reading that wrong is worse than being told to try again. A list
 * in GEMINI_MODEL still sets up a fallback for anyone who wants one.
 */
const DEFAULT_MODELS = ["gemini-flash-latest"];

/**
 * Thinking tokens come out of the output budget, and at "high" the model can
 * spend the whole budget thinking and return nothing. Reading notation needs
 * some thought, so "medium" rather than "low".
 */
const DEFAULT_THINKING = "medium";
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

/** Free-tier models get busy, and rate limits are per minute, so a failed
 *  request is often worth repeating after a wait. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_WAITS_MS = [2000, 6000, 15000];

/**
 * How long to keep asking a busy model (503) before giving up on it. Busy
 * spells last minutes, not seconds, and a slow reading beats none.
 */
const BUSY_PATIENCE_MS = Number(process.env.GEMINI_BUSY_PATIENCE_MS) || 5 * 60 * 1000;
const BUSY_WAIT_MS = 30000;

/**
 * The longest single wait worth sitting through. Once the daily allowance is
 * used, Google's Retry-After runs to the reset at midnight Pacific - hours -
 * and a reading should not hang that long when another model can take it.
 */
const MAX_WAIT_MS = 60 * 1000;

/** Why a lighter model may have to stand in, by the status that sent us to it. */
const FALLBACK_REASONS = { 503: "busy", 429: "limit" };

export const name = "gemini";
export const label = "Gemini";
export const keyName = "GEMINI_API_KEY";

export function available() {
    return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * The models to try, in order. GEMINI_MODEL is one model, or a comma-separated
 * list to fall through when the first is busy or out of requests.
 */
function models() {
    const listed = (process.env.GEMINI_MODEL ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    return listed.length ? listed : DEFAULT_MODELS;
}

/**
 * Gemini validates schemas more narrowly than Anthropic does, and rejects some
 * JSON Schema keywords, so drop the ones it does not take.
 */
function geminiSchema(schema) {
    if (Array.isArray(schema)) return schema.map(geminiSchema);
    if (!schema || typeof schema !== "object") return schema;

    const out = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === "additionalProperties") continue;
        out[key] = geminiSchema(value);
    }
    return out;
}

/** The image or document item for the input array. */
function sourceItem(file) {
    const data = file.buffer.toString("base64");

    if (file.mimetype === "application/pdf") {
        return { type: "document", mime_type: "application/pdf", data };
    }
    return { type: "image", mime_type: file.mimetype, data };
}

/** Lists the models this key can actually reach, to put in an error message. */
async function listModels(apiKey) {
    try {
        const response = await fetch(MODELS_ENDPOINT, {
            headers: { "x-goog-api-key": apiKey },
            dispatcher: patient,
        });
        if (!response.ok) return [];
        const body = await response.json();
        return (body.models ?? [])
            .map((entry) => String(entry.name ?? "").replace(/^models\//, ""))
            .filter((id) => id.includes("flash") || id.includes("pro"));
    } catch {
        return [];
    }
}

export async function generate({ system, text, file, schema }) {
    const apiKey = process.env.GEMINI_API_KEY;
    const candidates = models();

    // A PDF reads best with the pages first; a single image reads best with the
    // instruction first. Both orderings come from Google's own docs.
    const source = sourceItem(file);
    const input =
        source.type === "document"
            ? [source, { type: "text", text }]
            : [{ type: "text", text }, source];

    const requestFor = (chosen) => JSON.stringify({
        model: chosen,
        system_instruction: system,
        input,
        response_format: {
            type: "text",
            mime_type: "application/json",
            schema: geminiSchema(schema),
        },
        generation_config: {
            max_output_tokens: Number(
                process.env.GEMINI_MAX_OUTPUT_TOKENS || DEFAULT_MAX_OUTPUT_TOKENS,
            ),
            thinking_level: process.env.GEMINI_THINKING || DEFAULT_THINKING,
        },
    });

    let lastResponse;
    // Why the usual model was passed over, if it was: "busy" or "limit".
    let fallback = false;
    for (const chosen of candidates) {
        const response = await postWithRetries(apiKey, requestFor(chosen));

        if (response.ok) {
            // Say when a lighter model stood in, so the reading gets checked.
            return { ...readResult(await response.json(), chosen), fallback };
        }

        lastResponse = { response, chosen };
        // A busy or rate-limited model is worth stepping around - each model
        // has its own allowance - but anything else is a real error.
        const reason = FALLBACK_REASONS[response.status];
        if (!reason) break;
        fallback ||= reason;
        console.log(`gemini: ${chosen} ${reason === "busy" ? "stayed busy" : "is rate limited"}, trying the next model`);
    }

    throw await describeFailure(lastResponse.response, lastResponse.chosen, apiKey);
}

/**
 * Sends the request, waiting and trying again when the model is busy or the
 * rate limit is hit. A busy model is asked again for up to BUSY_PATIENCE_MS,
 * anything else a few times. Returns the last response either way, so the
 * caller can turn a persistent failure into a useful message.
 */
async function postWithRetries(apiKey, body) {
    const started = Date.now();
    let response;

    for (let attempt = 0; ; attempt++) {
        try {
            response = await fetch(ENDPOINT, {
                method: "POST",
                headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
                body,
                dispatcher: patient,
            });
        } catch (error) {
            throw networkFailure(error);
        }

        if (response.ok || !RETRY_STATUSES.has(response.status)) return response;

        // Honour Retry-After when the server sends one, else back off.
        const retryAfter = Number(response.headers.get("retry-after")) * 1000;
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter
            : RETRY_WAITS_MS[attempt] ?? BUSY_WAIT_MS;

        const busy = response.status === 503;
        const givenUp = busy
            ? Date.now() - started + wait > BUSY_PATIENCE_MS
            : attempt >= RETRY_WAITS_MS.length;
        if (givenUp || wait > MAX_WAIT_MS) return response;

        console.log(`gemini: ${response.status}, retrying in ${Math.round(wait / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, wait));
    }
}

function readResult(body, chosen) {
    if (body.status === "incomplete") {
        throw new TranscribeError(
            "The score was too long to transcribe in one go. Try a single page, a tighter crop, " +
                "or raise GEMINI_MAX_OUTPUT_TOKENS.",
            413,
        );
    }
    if (body.status === "failed" || body.errors?.length) {
        const why = body.errors?.[0]?.message ?? "the model reported a failure";
        throw new TranscribeError(`Gemini could not read this file (${why}).`, 422);
    }

    // The generated text lives in the model_output step's content array.
    const text_out = (body.steps ?? [])
        .filter((step) => step.type === "model_output")
        .flatMap((step) => step.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");

    return {
        text: text_out,
        model: body.model ?? chosen,
        usage: {
            input: body.usage?.total_input_tokens,
            output: body.usage?.total_output_tokens,
        },
    };
}

/** A request that never got an HTTP response, explained. */
function networkFailure(error) {
    const code = error?.cause?.code ?? error?.code;
    if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
        return new TranscribeError(
            `Gemini took longer than ${READ_TIMEOUT_MS / 60000} minutes to read the page. ` +
                "Try a single page or a tighter crop.",
            504,
        );
    }
    return new TranscribeError(
        `Could not reach Gemini (${error?.cause?.message ?? error?.message ?? "network error"}).`,
        502,
    );
}

/** Turns an HTTP failure into something that says what to do about it. */
async function describeFailure(response, chosen, apiKey) {
    const detail = await response.text();
    const message = (() => {
        try {
            return JSON.parse(detail)?.error?.message ?? detail;
        } catch {
            return detail;
        }
    })();

    if (response.status === 400 && /API key not valid/i.test(message)) {
        return new TranscribeError(
            "That GEMINI_API_KEY was rejected. Check it in Google AI Studio.",
            401,
        );
    }
    if (response.status === 404) {
        const models = await listModels(apiKey);
        const suggestion = models.length
            ? ` Models your key can use: ${models.slice(0, 8).join(", ")}.`
            : "";
        return new TranscribeError(
            `Gemini has no model called "${chosen}". Set GEMINI_MODEL to one that exists.${suggestion}`,
            400,
        );
    }
    if (response.status === 429) {
        // The daily allowance says "per day" and asks to come back in hours.
        const hours = Math.round(Number(response.headers.get("retry-after")) / 3600);
        if (/per day/i.test(message) || hours >= 1) {
            const when = hours >= 1 ? `, in about ${hours} hour${hours === 1 ? "" : "s"}` : "";
            return new TranscribeError(
                "Today's free Gemini readings are used up. They come back at midnight Pacific" +
                    `${when}. A key on a paid tier has no daily cap.`,
                429,
            );
        }
        return new TranscribeError(
            "Gemini's free tier allows only a few requests a minute, and that limit did not " +
                "clear. Wait a minute and try again.",
            429,
        );
    }
    if (response.status === 503) {
        return new TranscribeError(
            `Gemini has been too busy to answer for ${Math.round(BUSY_PATIENCE_MS / 60000)} minutes. ` +
                "Busy spells pass - try again in a few minutes.",
            503,
        );
    }
    return new TranscribeError(`Gemini request failed (${response.status}): ${message}`, 502);
}
