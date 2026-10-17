// Google Gemini over the REST Interactions API, for the server and the page
// alike: nothing here needs Node, only fetch.
//
// Reads are streamed. A read takes one to four minutes, and a phone's browser
// gives up on a request that stays silent for about one - so the model is
// asked to stream summaries of its thinking as it goes, which keeps data
// arriving every few seconds and says what it is doing. (Background mode,
// which would avoid the long request altogether, refuses images.)
//
// Gemini's free tier covers Flash, which takes both images and PDFs (PDFs
// natively, up to 1000 pages), so a scan does not have to become images first.

import { ReadError } from "./errors.js";

export const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * An alias, not a pinned version: it follows the current Flash model, and the
 * pinned ones go through spells of being too busy to answer.
 *
 * Flash only. Flash-Lite used to stand in when Flash was busy, but measured on
 * the accuracy samples it got 0-14% of pitches right, against about 90% for
 * Flash - a reading that wrong is worse than being told to try again. A list
 * of models still sets up a fallback for anyone who wants one.
 */
export const DEFAULT_MODELS = ["gemini-flash-latest"];

/**
 * Thinking tokens come out of the output budget, and at "high" the model can
 * spend the whole budget thinking and return nothing. Reading notation needs
 * some thought, so "medium" rather than "low" - and even at medium, Flash has
 * spent 31,456 tokens thinking about one page of Twinkle, so the budget is
 * Flash's whole 65,536: at 32,768 the score came back cut off.
 */
const DEFAULT_THINKING = "medium";
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

/** Free-tier models get busy, and rate limits are per minute, so a failed
 *  request is often worth repeating after a wait. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_WAITS_MS = [2000, 6000, 15000];

/**
 * How long to keep asking a busy model before giving up on it. Busy spells
 * last minutes, not seconds, and a slow reading beats none.
 */
const BUSY_PATIENCE_MS = 5 * 60 * 1000;
const BUSY_WAIT_MS = 30000;

/**
 * The longest single wait worth sitting through. Once the daily allowance is
 * used, Google's Retry-After runs to the reset at midnight Pacific - hours -
 * and a reading should not hang that long.
 */
const MAX_WAIT_MS = 60 * 1000;


/** Why a lighter model may have to stand in, by the status that sent us to it. */
const FALLBACK_REASONS = { 503: "busy", 429: "limit" };

/** What a finished read failing because the model was overloaded says. */
const OVERLOADED = /overload|high demand|unavailable|try again later/i;

/** How many times a read given up part-way as overloaded is started over. */
const OVERLOADED_RETRIES = 3;

/**
 * Reads a file with Gemini. `file` is `{ data, mimeType }`, the data base64;
 * `strips`, if the page was cut into strips, are more of the same, and are
 * sent in its place.
 * `settings`: `apiKey`, and optionally `models`, `apiBase`, `thinking`,
 * `maxOutputTokens`, `busyPatienceMs`, `fetch`, `log`, and `onProgress`,
 * called with each heading of the model's thinking as it streams in.
 */
export async function generate({ system, text, file, strips, schema }, settings) {
    const config = withDefaults(settings);

    // A PDF reads best with the pages first; an image reads best with the
    // instruction first. Both orderings come from Google's own docs. Strips
    // are each a line or two of music, read at the highest resolution there
    // is: the detail is the point of cutting the page up.
    const source = sourceItem(file);
    const input = strips?.length
        ? [{ type: "text", text }, ...strips.map(sourceItem).map((item) =>
            item.type === "image" ? { ...item, resolution: "ultra_high" } : item)]
        : source.type === "document"
          ? [source, { type: "text", text }]
          : [{ type: "text", text }, source];

    const requestFor = (model) => JSON.stringify({
        model,
        system_instruction: system,
        input,
        stream: true,
        // Kept by Google only as long as the request takes.
        store: false,
        response_format: { type: "text", mime_type: "application/json", schema: geminiSchema(schema) },
        generation_config: {
            max_output_tokens: config.maxOutputTokens,
            thinking_level: config.thinking,
            // Summaries of the thinking, streamed as it happens: the steady
            // trickle that keeps a phone's browser from giving up.
            thinking_summaries: "auto",
        },
    });

    let failure;
    // Why the usual model was passed over, if it was: "busy" or "limit".
    let fallback = false;
    for (const model of config.models) {
        const outcome = await read(requestFor(model), config);
        if (outcome.interaction) {
            // Say when a lighter model stood in, so the reading gets checked.
            return { ...readResult(outcome.interaction, model), fallback };
        }

        failure = { response: outcome.response, model };
        // A busy or rate-limited model is worth stepping around - each model
        // has its own allowance - but anything else is a real error.
        const reason = FALLBACK_REASONS[outcome.response.status];
        if (!reason || model === config.models.at(-1)) break;
        fallback ||= reason;
        config.log(`gemini: ${model} ${reason === "busy" ? "stayed busy" : "is rate limited"}, trying the next model`);
    }

    throw await describeFailure(failure.response, failure.model, config);
}

function withDefaults(settings) {
    return {
        apiKey: settings.apiKey,
        models: settings.models?.length ? settings.models : DEFAULT_MODELS,
        apiBase: settings.apiBase || API_BASE,
        thinking: settings.thinking || DEFAULT_THINKING,
        maxOutputTokens: Number(settings.maxOutputTokens) || DEFAULT_MAX_OUTPUT_TOKENS,
        busyPatienceMs: Number(settings.busyPatienceMs) || BUSY_PATIENCE_MS,
        fetch: settings.fetch ?? globalThis.fetch.bind(globalThis),
        log: settings.log ?? (() => {}),
        onProgress: settings.onProgress ?? (() => {}),
    };
}

/**
 * One read with one model: start it, then follow its stream to the end.
 * Returns `{ interaction }` once it has finished, or `{ response }` for a
 * request Gemini turned away, so the caller can try another model or explain.
 */
async function read(body, config) {
    for (let dropped = 0; ; dropped++) {
        const response = await startWithRetries(body, config, Date.now());
        if (!response.ok) return { response };

        const interaction = await follow(response, config);

        // The stream was cut before the end - a browser's is, at about five
        // minutes, and a dense page takes longer than that. What was written
        // is kept, as if the answer had run out of room, and the reading
        // carries on from it; cut before writing anything, it starts over.
        if (interaction.status === "cut") {
            if (interaction.steps[0].content[0].text) return { interaction: { ...interaction, status: "incomplete" } };
            if (dropped >= OVERLOADED_RETRIES) {
                throw new ReadError("The connection to Gemini kept dropping before the reading was finished. Try again.", 502);
            }
            config.log(`gemini: the stream was cut (${interaction.why}) before any answer, starting again`);
            config.onProgress("The connection dropped - starting again");
            continue;
        }

        // A read can also be given up part-way, as overloaded - minutes in,
        // on a long page. That is the busy case again: it is worth starting
        // over, a few times, each start with its own patience.
        const why = interaction.error?.message ?? interaction.errors?.[0]?.message ?? "";
        const busy = interaction.status === "failed" && OVERLOADED.test(why);
        if (!busy || dropped >= OVERLOADED_RETRIES) return { interaction };

        const wait = Math.min(BUSY_WAIT_MS, config.busyPatienceMs);
        config.log(`gemini: the read failed as overloaded, retrying in ${Math.round(wait / 1000)}s`);
        config.onProgress("Gemini is busy - starting again shortly");
        await sleep(wait);
    }
}

/**
 * Starts the read, waiting and trying again when the model is busy or the
 * rate limit is hit. A busy model is asked again for up to the busy patience,
 * anything else a few times. Returns the last response either way.
 */
async function startWithRetries(body, config, started) {
    for (let attempt = 0; ; attempt++) {
        const response = await call(config, "/interactions?alt=sse", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });
        if (response.ok || !RETRY_STATUSES.has(response.status)) return response;

        // Wait as long as Google asks, else back off.
        const asked = await retryDelay(response);
        const wait = asked > 0 ? asked : RETRY_WAITS_MS[attempt] ?? BUSY_WAIT_MS;

        const busy = response.status === 503;
        const givenUp = busy
            ? Date.now() - started + wait > config.busyPatienceMs
            : attempt >= RETRY_WAITS_MS.length;
        if (givenUp || wait > MAX_WAIT_MS) return response;

        config.log(`gemini: ${response.status}, retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
    }
}

/**
 * How long Google asks to wait before trying again, in milliseconds, or 0.
 * Retry-After says, where it can be read - but a browser cannot read it
 * cross-origin - so the error body is read too: a RetryInfo detail's
 * "retryDelay": "32s", or "Please retry in 32.5s" (or "in 12h59m15s").
 */
async function retryDelay(response) {
    const header = Number(response.headers.get("retry-after"));
    if (header > 0) return header * 1000;

    let error;
    try {
        error = (await response.clone().json())?.error;
    } catch {
        return 0;
    }
    const detail = error?.details?.find((d) => d.retryDelay)?.retryDelay;
    if (detail && Number.parseFloat(detail) > 0) return Number.parseFloat(detail) * 1000;

    const said = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(error?.message ?? "");
    if (!said) return 0;
    const [, hours = 0, minutes = 0, seconds = 0] = said;
    return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/**
 * Follows a read's event stream to its end, and returns the interaction as a
 * finished one looks: its status, model, usage, and the text it wrote.
 */
async function follow(response, config) {
    const kinds = []; // each step's type, by index
    let text = "";
    let finished = null;

    const handle = (event) => {
        if (event.error) {
            // Overloaded part-way is the busy case again: ended as a failed
            // read, so it is waited out and tried again like any other.
            if (OVERLOADED.test(event.error.message ?? "")) {
                finished = { status: "failed", error: event.error };
                return;
            }
            throw new ReadError(`Gemini stopped reading (${event.error.message ?? "an error"}).`, 502);
        }
        switch (event.event_type) {
            case "step.start":
                kinds[event.index] = event.step?.type;
                break;
            case "step.delta":
                if (event.delta?.type === "text" && kinds[event.index] === "model_output") {
                    text += event.delta.text ?? "";
                } else if (event.delta?.type === "thought_summary") {
                    // "**Deciphering the Clef**\n\nI've determined..." - the heading.
                    const heading = /\*\*(.+?)\*\*/.exec(event.delta.content?.text ?? "")?.[1];
                    if (heading) config.onProgress(heading);
                }
                break;
            case "interaction.completed":
                finished = event.interaction;
                break;
        }
    };

    try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffered += decoder.decode(value, { stream: true });
            // Server-sent events: blank-line separated, data on "data:" lines.
            let end;
            while ((end = buffered.indexOf("\n\n")) >= 0) {
                const data = buffered.slice(0, end).split("\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trim())
                    .join("");
                buffered = buffered.slice(end + 2);
                if (data && data !== "[DONE]") handle(JSON.parse(data));
            }
        }
    } catch (error) {
        if (error instanceof ReadError) throw error;
        // Dropped part-way: what arrived is still worth having.
        return cut(error?.message ?? "network error");
    }

    if (!finished) return cut("closed early");
    return {
        ...finished,
        steps: [{ type: "model_output", content: [{ type: "text", text }] }],
    };

    function cut(why) {
        return { status: "cut", why, steps: [{ type: "model_output", content: [{ type: "text", text }] }] };
    }
}

/** A request to the API, with the key, and network failures explained. */
async function call(config, path, init) {
    try {
        return await config.fetch(`${config.apiBase}${path}`, {
            ...init,
            headers: { ...init.headers, "x-goog-api-key": config.apiKey },
        });
    } catch (error) {
        throw new ReadError(
            `Could not reach Gemini (${error?.cause?.message ?? error?.message ?? "network error"}).`,
            502,
        );
    }
}

function readResult(body, model) {
    if (!["completed", "incomplete"].includes(body.status) || body.errors?.length) {
        const why = body.error?.message ?? body.errors?.[0]?.message ?? `the read ended as ${body.status}`;
        if (OVERLOADED.test(why)) {
            throw new ReadError("Gemini is too busy to finish a reading just now. Busy spells pass - try again in a few minutes.", 503);
        }
        throw new ReadError(`Gemini could not read this file (${why}).`, 422);
    }

    // The generated text lives in the model_output step's content array.
    const text = (body.steps ?? [])
        .filter((step) => step.type === "model_output")
        .flatMap((step) => step.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");

    // Incomplete is the output budget running out. Thinking comes out of the
    // same budget, so a read can be cut off before writing anything at all.
    const incomplete = body.status === "incomplete";
    if (incomplete && !text) {
        throw new ReadError(
            "Gemini spent its whole answer working out the page and had no room left to write it " +
                "down. Try again, or try a tighter crop.",
            413,
        );
    }

    return {
        text,
        // Cut off part-way: the reading carries on from where it got to.
        incomplete,
        model: body.model ?? model,
        usage: {
            input: body.usage?.total_input_tokens,
            output: body.usage?.total_output_tokens,
            thinking: body.usage?.total_thought_tokens,
        },
    };
}

/** Turns an HTTP failure into something that says what to do about it. */
async function describeFailure(response, model, config) {
    const detail = await response.text();
    const message = (() => {
        try {
            return JSON.parse(detail)?.error?.message ?? detail;
        } catch {
            return detail;
        }
    })();

    if ((response.status === 400 || response.status === 403) && /API key/i.test(message)) {
        return new ReadError("That Gemini API key was rejected. Check it in Google AI Studio.", 401);
    }
    if (response.status === 404) {
        const models = await listModels(config);
        const suggestion = models.length ? ` Models your key can use: ${models.slice(0, 8).join(", ")}.` : "";
        return new ReadError(`Gemini has no model called "${model}".${suggestion}`, 400);
    }
    if (response.status === 429) {
        const hours = hoursUntilReset(response, message);
        if (/per day/i.test(message) || hours >= 1) {
            const when = hours >= 1 ? `, in about ${hours} hour${hours === 1 ? "" : "s"}` : "";
            return new ReadError(
                "Today's free Gemini readings are used up. They come back at midnight Pacific" +
                    `${when}. A key on a paid tier has no daily cap.`,
                429,
            );
        }
        return new ReadError(
            "Gemini's free tier allows only a few requests a minute, and that limit did not " +
                "clear. Wait a minute and try again.",
            429,
        );
    }
    if (response.status === 503) {
        return new ReadError(
            `Gemini has been too busy to answer for ${Math.round(config.busyPatienceMs / 60000)} minutes. ` +
                "Busy spells pass - try again in a few minutes.",
            503,
        );
    }
    return new ReadError(`Gemini request failed (${response.status}): ${message}`, 502);
}

/**
 * Hours until the daily allowance resets: from Retry-After where it can be
 * read, else from Google's "retry in 12h59m" in the message, else by the
 * clock, to midnight Pacific.
 */
function hoursUntilReset(response, message) {
    const header = Number(response.headers.get("retry-after"));
    if (header > 0) return Math.round(header / 3600);

    const said = /retry in (\d+)h/i.exec(message);
    if (said) return Number(said[1]);

    if (!/per day/i.test(message)) return 0;
    const pacific = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const midnight = new Date(pacific);
    midnight.setHours(24, 0, 0, 0);
    return Math.round((midnight - pacific) / 3600000);
}

/** Lists the models this key can actually reach, to put in an error message. */
async function listModels(config) {
    try {
        const response = await call(config, "/models", { method: "GET" });
        if (!response.ok) return [];
        const body = await response.json();
        return (body.models ?? [])
            .map((entry) => String(entry.name ?? "").replace(/^models\//, ""))
            .filter((id) => id.includes("flash") || id.includes("pro"));
    } catch {
        return [];
    }
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
    if (file.mimeType === "application/pdf") {
        return { type: "document", mime_type: "application/pdf", data: file.data };
    }
    return { type: "image", mime_type: file.mimeType, data: file.data };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
