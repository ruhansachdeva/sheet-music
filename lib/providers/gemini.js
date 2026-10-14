// Google Gemini provider, over the REST Interactions API - no extra dependency.
//
// Gemini's free tier covers the Flash models, which take both images and PDFs
// (PDFs natively, up to 1000 pages), so a scan does not have to be rendered to
// images first.

import { TranscribeError } from "../errors.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export const name = "gemini";
export const label = "Gemini";
export const keyName = "GEMINI_API_KEY";

export function available() {
    return Boolean(process.env.GEMINI_API_KEY);
}

function model() {
    return process.env.GEMINI_MODEL || DEFAULT_MODEL;
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
        const response = await fetch(MODELS_ENDPOINT, { headers: { "x-goog-api-key": apiKey } });
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
    const chosen = model();

    // A PDF reads best with the pages first; a single image reads best with the
    // instruction first. Both orderings come from Google's own docs.
    const source = sourceItem(file);
    const input =
        source.type === "document"
            ? [source, { type: "text", text }]
            : [{ type: "text", text }, source];

    const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
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
                thinking_level: "high",
            },
        }),
    });

    if (!response.ok) {
        throw await describeFailure(response, chosen, apiKey);
    }

    const body = await response.json();

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
        return new TranscribeError(
            "Gemini's free tier rate limit was hit. Wait a minute and try again - the free tier " +
                "allows only a few requests per minute, and resets daily.",
            429,
        );
    }
    return new TranscribeError(`Gemini request failed (${response.status}): ${message}`, 502);
}
