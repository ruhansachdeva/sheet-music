// Checks how the Gemini provider copes with a busy model, against a fake
// Gemini on localhost - no key, no network, and no real waiting.
//
//   npm run test:provider

import { createServer } from "node:http";
import { once } from "node:events";

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}`);
    if (!ok) { console.log(`       expected ${JSON.stringify(expected)}`); failures += 1; }
}

/**
 * What the fake does next, per model: a list of statuses to answer with, the
 * last one repeating. Every request is counted by model.
 */
let script = {};
let asked = {};

const fake = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { model } = JSON.parse(body || "{}");
    asked[model] = (asked[model] ?? 0) + 1;

    const plan = script[model] ?? [200];
    const status = plan[Math.min(asked[model] - 1, plan.length - 1)];
    if (status !== 200) {
        // A tiny Retry-After, so the provider's waits take milliseconds.
        response.writeHead(status, { "content-type": "application/json", "retry-after": "0.01" });
        response.end(JSON.stringify({ error: { message: `fake ${status}` } }));
        return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
        status: "completed",
        model,
        steps: [{ type: "model_output", content: [{ type: "text", text: `{"read by":"${model}"}` }] }],
        usage: { total_input_tokens: 1, total_output_tokens: 1 },
    }));
});
fake.listen(0);
await once(fake, "listening");

// The provider reads these when it loads, so they are set before the import.
process.env.GEMINI_API_BASE = `http://localhost:${fake.address().port}`;
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_BUSY_PATIENCE_MS = "400";
delete process.env.GEMINI_MODEL;
const gemini = await import("../lib/providers/gemini.js");

const request = {
    system: "",
    text: "",
    file: { buffer: Buffer.from("x"), mimetype: "image/png" },
    schema: { type: "object" },
};
async function read(plan) {
    script = plan;
    asked = {};
    try {
        const result = await gemini.generate(request);
        return { model: result.model, fallback: result.fallback, asked };
    } catch (error) {
        return { error: error.status ?? error.message, asked };
    }
}

try {
    console.log("\na busy model is waited for");
    const brief = await read({ "gemini-flash-latest": [503, 503, 503, 503, 200] });
    check("Flash answers after four busy replies", brief.model, "gemini-flash-latest");
    check("so no lighter model stood in", brief.fallback, false);
    check("and Flash-Lite was never asked", brief.asked["gemini-flash-lite-latest"] ?? 0, 0);

    console.log("\nfor as long as patience allows, then a lighter one reads it");
    const long = await read({ "gemini-flash-latest": [503], "gemini-flash-lite-latest": [200] });
    check("Flash-Lite answers once Flash has been busy too long", long.model, "gemini-flash-lite-latest");
    check("and the reading says a lighter model stood in", long.fallback, true);
    check("after Flash was asked more than the old three retries", long.asked["gemini-flash-latest"] > 4, true);

    console.log("\nother failures are retried a few times, not waited out");
    const broken = await read({ "gemini-flash-latest": [500] });
    check("a server error gives up after three retries", broken.asked["gemini-flash-latest"], 4);
    check("without handing over to a lighter model", broken.asked["gemini-flash-lite-latest"] ?? 0, 0);
    check("and fails with the server's status", broken.error, 502);
} finally {
    fake.close();
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
