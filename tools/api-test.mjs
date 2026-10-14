// Checks the server's request handling without calling a model: that it
// accepts every instrument the picker offers, and rejects what it should.
//
//   npm run test:api

import { spawn } from "node:child_process";
import { INSTRUMENTS } from "../public/js/instruments.js";

const PORT = Number(process.env.TEST_PORT ?? 3113);
const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}`);
    if (!ok) { console.log(`       expected ${JSON.stringify(expected)}`); failures += 1; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A one-pixel PNG, so there is a real image to post.
const PIXEL = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

async function post(path, fields) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        if (key === "file") form.append("file", new Blob([value], { type: "image/png" }), "page.png");
        else form.append(key, value);
    }
    const response = await fetch(`http://localhost:${PORT}${path}`, { method: "POST", body: form });
    return { status: response.status, body: await response.json().catch(() => ({})) };
}

// No key is set for this run, so a request that gets past validation stops at
// the missing-key check. That is the signal the instrument was accepted.
const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", PROVIDER: "" },
    stdio: ["ignore", "ignore", "ignore"],
});

try {
    for (let i = 0; i < 60; i++) {
        try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
        await sleep(100);
    }

    console.log("\nevery instrument in the picker is accepted");
    for (const instrument of Object.keys(INSTRUMENTS)) {
        const { status, body } = await post("/api/transcribe", { file: PIXEL, instrument });
        // 500 is the missing-key stop, which means validation passed.
        const accepted = status === 500 && /API key/i.test(body.error ?? "");
        check(instrument, accepted, true);
    }

    console.log("\nand bad input is still refused");
    check("an unknown instrument", (await post("/api/transcribe", { file: PIXEL, instrument: "banjo" })).status, 400);
    check("no file", (await post("/api/transcribe", { instrument: "piano" })).status, 400);
    check("refine without musicxml", (await post("/api/refine", { file: PIXEL, instrument: "piano" })).status, 400);
    check(
        "refine without answers",
        (await post("/api/refine", { file: PIXEL, instrument: "piano", musicxml: "<score-partwise/>" })).status,
        400,
    );
} finally {
    server.kill();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
