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
 * What the fake does next, per model: a list of statuses to answer a read
 * with, the last one repeating. A status can be [status, retryAfterSeconds].
 * A 200 streams the read as Gemini does - a thinking summary, the answer in
 * pieces, then "completed" - and "failed" streams a read that fails, "cut" one
 * whose connection drops before the end, "incomplete" one that runs out of
 * room part-way, and "all thinking" one that runs out before writing anything.
 * Every request is counted by model.
 */
let script = {};
let asked = {};

/** One server-sent event, as Gemini sends them. */
const sse = (event) => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`;

const fake = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { model, stream, store, generation_config: config } = JSON.parse(body || "{}");
    asked[model] = (asked[model] ?? 0) + 1;
    asked.last = { stream, store, summaries: config?.thinking_summaries, budget: config?.max_output_tokens };

    const plan = script[model] ?? [200];
    const step = plan[Math.min(asked[model] - 1, plan.length - 1)];
    // A rate limit as a browser sees it: no Retry-After it can read, and the
    // wait only in the body - in Google's message, or a RetryInfo detail.
    if (step === "429, said" || step === "429, detailed") {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: step === "429, said"
            ? { message: "Quota exceeded for requests per minute. Please retry in 0.3s." }
            : { message: "Quota exceeded.", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.3s" }] } }));
        return;
    }
    // A tiny Retry-After by default, so the provider's waits take milliseconds.
    const [status, retryAfter] = Array.isArray(step) ? step : [step, 0.01];
    if (typeof status === "number" && status !== 200) {
        response.writeHead(status, { "content-type": "application/json", "retry-after": String(retryAfter) });
        response.end(JSON.stringify({ error: { message: `fake ${status}` } }));
        return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    const answer = `{"read by":"${model}"}`;
    response.write(sse({ event_type: "interaction.created", interaction: { id: "x", model } }));
    response.write(sse({ event_type: "step.start", index: 0, step: { type: "thought" } }));
    response.write(sse({ event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { text: "**Reading the Clef**\n\nIt is treble." } } }));
    response.write(sse({ event_type: "step.stop", index: 0 }));
    // Given up part-way, as Gemini does under load: an error event, then the end.
    if (status === "dropped") {
        return response.end(sse({ event_type: "error", error: { code: 503, message: `${model} is currently experiencing high demand. Please try again later.` } }));
    }
    // Cut while still thinking, before any answer: the stream just ends.
    if (status === "cut early") return response.end();
    if (status === "all thinking") {
        return response.end(sse({ event_type: "interaction.completed", interaction: { id: "x", model, status: "incomplete" } }));
    }
    response.write(sse({ event_type: "step.start", index: 1, step: { type: "model_output" } }));
    // The answer in two pieces, the first split mid-event, as a network may.
    const first = sse({ event_type: "step.delta", index: 1, delta: { type: "text", text: answer.slice(0, 6) } });
    response.write(first.slice(0, 20));
    response.write(first.slice(20));
    if (status === "cut") return response.end();
    response.write(sse({ event_type: "step.delta", index: 1, delta: { type: "text", text: answer.slice(6) } }));
    response.write(sse({ event_type: "step.stop", index: 1 }));
    response.end(sse({
        event_type: "interaction.completed",
        interaction: status === "failed"
            ? { id: "x", model, status: "failed", error: { message: "the fake gave up" } }
            : { id: "x", model, status: status === "incomplete" ? "incomplete" : "completed",
                usage: { total_input_tokens: 1, total_output_tokens: 1, total_thought_tokens: 2 } },
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
/** Reads once against the plan. `models` is GEMINI_MODEL, or the default. */
async function read(plan, models = "") {
    script = plan;
    asked = {};
    process.env.GEMINI_MODEL = models;
    try {
        const result = await gemini.generate(request);
        return { model: result.model, fallback: result.fallback, text: result.text, incomplete: result.incomplete, usage: result.usage, asked };
    } catch (error) {
        return { error: error.status ?? error.message, message: error.message, asked };
    }
}
const WITH_LITE = "gemini-flash-latest, gemini-flash-lite-latest";

try {
    console.log("\na read is streamed");
    const streamed = await read({ "gemini-flash-latest": [200] });
    check("it is streamed, and not stored", [asked.last.stream, asked.last.store], [true, false]);
    check("with the thinking summarised as it goes", asked.last.summaries, "auto");
    check("and the whole of Flash's output budget", asked.last.budget, 65536);
    check("the answer is put together from its pieces", streamed.model, "gemini-flash-latest");
    const failedRead = await read({ "gemini-flash-latest": ["failed"] });
    check("a read that fails part-way says so", [failedRead.error, /fake gave up/.test(failedRead.message)], [422, true]);
    const cut = await read({ "gemini-flash-latest": ["cut"] });
    check("a stream cut part-way comes back with what it wrote, to be carried on",
        [cut.incomplete, cut.text], [true, '{"read']);
    const cutEarly = await read({ "gemini-flash-latest": ["cut early", 200] });
    check("one cut before any answer is started over", [cutEarly.model, cutEarly.asked["gemini-flash-latest"]], ["gemini-flash-latest", 2]);
    const keptCutting = await read({ "gemini-flash-latest": ["cut early"] });
    check("three times at most, then it says so",
        [keptCutting.asked["gemini-flash-latest"], keptCutting.error, /kept dropping/.test(keptCutting.message)], [4, 502, true]);

    const dropped = await read({ "gemini-flash-latest": ["dropped", 200] });
    check("a read dropped part-way for high demand is started over", [dropped.model, dropped.asked["gemini-flash-latest"]], ["gemini-flash-latest", 2]);
    const droppedAgain = await read({ "gemini-flash-latest": ["dropped"] });
    check("three times at most, then it says so", [droppedAgain.asked["gemini-flash-latest"], droppedAgain.error, /too busy/.test(droppedAgain.message)], [4, 503, true]);

    console.log("\na read that runs out of room");
    check("a finished read is not marked incomplete", streamed.incomplete, false);
    check("with the thinking it took counted", streamed.usage, { input: 1, output: 1, thinking: 2 });
    const outOfRoom = await read({ "gemini-flash-latest": ["incomplete"] });
    check("one cut off part-way comes back, marked incomplete, to be carried on",
        [outOfRoom.incomplete, outOfRoom.text], [true, '{"read by":"gemini-flash-latest"}']);
    const allThinking = await read({ "gemini-flash-latest": ["all thinking"] });
    check("one that thought until it ran out says so",
        [allThinking.error, /no room left to write it down/.test(allThinking.message)], [413, true]);

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

    console.log("\nthe wait Google asks for is read from the body too");
    // A browser cannot read Retry-After cross-origin. Waiting Google's 0.3s,
    // not the 2s fallback, shows the body was read.
    for (const kind of ["said", "detailed"]) {
        const begun = Date.now();
        const waited = await read({ "gemini-flash-latest": [`429, ${kind}`, 200] });
        const took = Date.now() - begun;
        check(`a wait ${kind === "said" ? "in the message" : "in a RetryInfo detail"} is honoured`,
            [waited.model, took >= 300 && took < 1500], ["gemini-flash-latest", true]);
    }

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
