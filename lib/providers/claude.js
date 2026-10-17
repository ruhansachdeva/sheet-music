// Anthropic provider. Reads photos and PDFs with Claude.

import Anthropic from "@anthropic-ai/sdk";
import { TranscribeError } from "../errors.js";

const DEFAULT_MODEL = "claude-opus-5-5";

/** Beta that enables server-side refusal fallbacks in their "default" form. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** MusicXML can run to tens of thousands of tokens, so give the model room. */
const MAX_TOKENS = 64000;

export const name = "claude";
export const label = "Claude";
export const keyName = "ANTHROPIC_API_KEY";

export function available() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
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

export async function generate({ system, text, file, strips, schema }) {
    const client = new Anthropic();
    const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;

    // Streamed, because a full score of MusicXML takes a while to generate and
    // a non-streaming request would hit the SDK's HTTP timeout.
    const stream = client.beta.messages.stream({
        model,
        max_tokens: MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: {
            effort: "high",
            format: { type: "json_schema", schema },
        },
        system,
        // A page cut into strips is sent as the strips, top to bottom.
        messages: [{ role: "user", content: [...(strips?.length ? strips : [file]).map(sourceBlock), { type: "text", text }] }],
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
        const why = message.stop_details?.explanation ?? "no explanation given";
        throw new TranscribeError(`Claude declined to read this file (${why}).`, 422);
    }

    const answer = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    // Out of room: the reading carries on from where this one got to, if it
    // got anywhere.
    const incomplete = message.stop_reason === "max_tokens";
    if (incomplete && !answer) {
        throw new TranscribeError(
            "Claude spent its whole answer working out the page and had no room left to write it " +
                "down. Try again, or try a tighter crop.",
            413,
        );
    }

    return {
        text: answer,
        incomplete,
        model: message.model,
        usage: {
            input: message.usage?.input_tokens,
            output: message.usage?.output_tokens,
        },
    };
}
