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
 * What the fake does next, per model: a list of statuses to answer a read's
 * start with, the last one repeating. A status can be [status,
 * retryAfterSeconds]. Every start is counted by model. A started read is
 * "in_progress" for `pollsBeforeDone` polls, then complete - or, for the
 * status "failed", fails.
 */
let script = {};
let asked = {};
let pollsBeforeDone = 2;
const reads = new Map();
const deleted = [];

const fake = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;

    // Background mode: asking after a read, and clearing it up afterwards.
    const id = /\/interactions\/([^/]+)$/.exec(request.url)?.[1];
    if (id && request.method === "DELETE") {
        deleted.push(id);
        response.end("{}");
        return;
    }
    if (id) {
        const read = reads.get(id);
        read.polls += 1;
        const done = read.polls > pollsBeforeDone;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(
            !done ? { id, status: "in_progress", model: read.model }
            : read.fails ? { id, status: "failed", model: read.model, error: { message: "the fake gave up" } }
            : {
                  id,
                  status: "completed",
                  model: read.model,
                  steps: [{ type: "model_output", content: [{ type: "text", text: `{"read by":"${read.model}"}` }] }],
                  usage: { total_input_tokens: 1, total_output_tokens: 1 },
              },
        ));
        return;
    }

    const { model, background } = JSON.parse(body || "{}");
    asked[model] = (asked[model] ?? 0) + 1;
    asked.background = background;

    const plan = script[model] ?? [200];
    const step = plan[Math.min(asked[model] - 1, plan.length - 1)];
    // A tiny Retry-After by default, so the provider's waits take milliseconds.
    const [status, retryAfter] = Array.isArray(step) ? step : [step, 0.01];
    if (status !== 200 && status !== "failed") {
        response.writeHead(status, { "content-type": "application/json", "retry-after": String(retryAfter) });
        response.end(JSON.stringify({ error: { message: `fake ${status}` } }));
        return;
    }
    const started = `read-${reads.size + 1}`;
    reads.set(started, { model, polls: 0, fails: status === "failed" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: started, status: "in_progress", model }));
});
fake.listen(0);
await once(fake, "listening");

// The provider reads these when it loads, so they are set before the import.
process.env.GEMINI_API_BASE = `http://localhost:${fake.address().port}`;
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_BUSY_PATIENCE_MS = "400";
process.env.GEMINI_POLL_MS = "10";
delete process.env.GEMINI_MODEL;
const gemini = await import("../lib/providers/gemini.js");

const request = {
    system: "",
    text: "",
    file: { buffer: Buffer.from("x"), mimetype: "image/png" },
    schema: { type: "object" },
};
/** Reads once against the plan. `models` is GEMINI_MODEL, or the default. */
async function read(plan, models = "") {
    script = plan;
    asked = {};
    process.env.GEMINI_MODEL = models;
    try {
        const result = await gemini.generate(request);
        return { model: result.model, fallback: result.fallback, asked };
    } catch (error) {
        return { error: error.status ?? error.message, message: error.message, asked };
    }
}
const WITH_LITE = "gemini-flash-latest, gemini-flash-lite-latest";

try {
    console.log("\na read runs in the background and is polled");
    pollsBeforeDone = 3;
    const polled = await read({ "gemini-flash-latest": [200] });
    const thatRead = [...reads.values()].at(-1);
    check("it is started in background mode", asked.background, true);
    check("asked after until it is done", thatRead.polls, 4);
    check("and its result read", polled.model, "gemini-flash-latest");
    // The clear-up is not waited for, so give it a moment to arrive.
    await new Promise((r) => setTimeout(r, 100));
    check("then cleared off Google's side", deleted.includes([...reads.keys()].at(-1)), true);
    pollsBeforeDone = 1;
    const failedRead = await read({ "gemini-flash-latest": ["failed"] });
    check("a read that fails once started says so", [failedRead.error, /fake gave up/.test(failedRead.message)], [422, true]);

    console.log("\na busy model is waited for");
    const brief = await read({ "gemini-flash-latest": [503, 503, 503, 503, 200] });
    check("Flash answers after four busy replies", brief.model, "gemini-flash-latest");
    check("so no lighter model stood in", brief.fallback, false);
    check("and Flash-Lite was never asked", brief.asked["gemini-flash-lite-latest"] ?? 0, 0);

    console.log("\nfor as long as patience allows, then it says so");
    const long = await read({ "gemini-flash-latest": [503], "gemini-flash-lite-latest": [200] });
    check("a Flash busy too long fails as busy", long.error, 503);
    check("after being asked more than the old three retries", long.asked["gemini-flash-latest"] > 4, true);
    check("and Flash-Lite, too inaccurate to stand in, is never asked", long.asked["gemini-flash-lite-latest"] ?? 0, 0);

    console.log("\na fallback is there for whoever lists one");
    const listed = await read({ "gemini-flash-latest": [503], "gemini-flash-lite-latest": [200] }, WITH_LITE);
    check("Flash-Lite answers once Flash has been busy too long", listed.model, "gemini-flash-lite-latest");
    check("and the reading says a lighter model stood in, and why", listed.fallback, "busy");

    console.log("\na brief rate limit is waited out");
    const minute = await read({ "gemini-flash-latest": [429, 429, 200] });
    check("Flash answers once the per-minute limit clears", [minute.model, minute.fallback],
        ["gemini-flash-latest", false]);

    console.log("\nthe daily limit is not waited out");
    let started = Date.now();
    // Google's answer once the day's requests are spent: come back in 13 hours.
    const daily = await read({ "gemini-flash-latest": [[429, 46755]] });
    check("it fails straight away, not after a 13-hour Retry-After", Date.now() - started < 2000, true);
    check("as a rate limit", daily.error, 429);
    check("saying when the readings come back",
        /midnight Pacific, in about 13 hours/.test(daily.message), true);
    check("without asking Flash again", daily.asked["gemini-flash-latest"], 1);

    started = Date.now();
    const dailyListed = await read({ "gemini-flash-latest": [[429, 46755]], "gemini-flash-lite-latest": [200] }, WITH_LITE);
    check("with a fallback listed, its own allowance is used", dailyListed.model, "gemini-flash-lite-latest");
    check("and the reading says the usual model hit its limit", dailyListed.fallback, "limit");
    check("still without waiting", Date.now() - started < 2000, true);

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
