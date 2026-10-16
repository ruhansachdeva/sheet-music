// Google Gemini provider for the server. The client itself is shared with the
// page (public/js/reader/gemini.js); this only supplies its settings from the
// environment and hands it the uploaded file.

import { generate as read } from "../../public/js/reader/gemini.js";

export const name = "gemini";
export const label = "Gemini";
export const keyName = "GEMINI_API_KEY";

export function available() {
    return Boolean(process.env.GEMINI_API_KEY);
}

export function generate({ system, text, file, schema }) {
    return read(
        {
            system,
            text,
            file: { data: file.buffer.toString("base64"), mimeType: file.mimetype },
            schema,
        },
        {
            apiKey: process.env.GEMINI_API_KEY,
            // One model, or a comma-separated list to fall through when the
            // first is busy or out of requests.
            models: (process.env.GEMINI_MODEL ?? "").split(",").map((m) => m.trim()).filter(Boolean),
            // A proxy - or, in the tests, a stand-in for Gemini on localhost.
            apiBase: process.env.GEMINI_API_BASE,
            thinking: process.env.GEMINI_THINKING,
            maxOutputTokens: process.env.GEMINI_MAX_OUTPUT_TOKENS,
            busyPatienceMs: process.env.GEMINI_BUSY_PATIENCE_MS,
            pollMs: process.env.GEMINI_POLL_MS,
            log: console.log,
        },
    );
}
