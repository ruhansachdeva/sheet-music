// Reads a photo end to end - upload, read, clarifying question, answer,
// corrected score - through the real server and page, with a stand-in for
// Gemini on localhost. No key, no network, and nothing on the free tier spent.
//
//   npm run test:read-flow
//
// It needs a Chromium binary: Playwright's cached one, or set CHROME_PATH.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.TEST_PORT ?? 3114);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}`);
    if (!ok) { console.log(`       expected ${JSON.stringify(expected)}`); failures += 1; }
}

function findChrome() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const cache = join(homedir(), "Library/Caches/ms-playwright");
    if (existsSync(cache)) {
        for (const dir of readdirSync(cache)) {
            const candidate = join(cache, dir, "chrome-headless-shell-mac-arm64/chrome-headless-shell");
            if (existsSync(candidate)) return candidate;
        }
    }
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(chrome)) return chrome;
    throw new Error("No Chromium found. Set CHROME_PATH.");
}

// --- the stand-in reader --------------------------------------------------
// The first read asks one question; the answer gets a different score back,
// so the page visibly changes when the correction lands.
const twinkle = readFileSync(join(ROOT, "samples/twinkle.musicxml"), "utf8");
const timing = readFileSync(join(ROOT, "samples/timing-test.musicxml"), "utf8");
const asked = [];
// What the stand-in does: read normally, or fail the way Gemini can.
let behaviour = "read";
// For a page too long for one answer: where each request said the score stopped.
let carriedOn = [];
// Twinkle with bar 2's first note read as an eighth, so the bar comes up short;
// and what a recheck of it was asked, and whether it can fix it.
const bar2 = /<measure number="2"[\s\S]*?<\/measure>/.exec(twinkle)[0];
const misread = twinkle.replace(bar2, bar2.replace("<duration>480</duration>", "<duration>240</duration>"));
let rechecked = [];
let recheckFixes = true;
// Twinkle with bars 1 and 2 skipped, as when a strip is passed over: bar 3
// opens the part, with the attributes. And what was asked for to fill it.
const barOf = (n) => new RegExp(`<measure number="${n}"[\\s\\S]*?</measure>`).exec(twinkle)[0];
const opening = /<attributes>[\s\S]*?<\/attributes>/.exec(barOf(1))[0];
const skipping = twinkle.replace(barOf(1), "").replace(barOf(2), "")
    .replace(/(<measure number="3"[^>]*>)/, `$1${opening}`);
let filled = [];
let rereadAsked = [];

const reader = createServer(async (request, response) => {
    // The page on the hosted site calls Gemini straight from the browser, so
    // the stand-in answers cross-origin requests as Gemini does.
    const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, x-goog-api-key",
        "access-control-allow-methods": "GET, POST, DELETE",
    };
    const reply = (status, body, extra = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...cors, ...extra });
        response.end(JSON.stringify(body));
    };
    if (request.method === "OPTIONS") return reply(204, {});

    let body = "";
    for await (const chunk of request) body += chunk;
    // A key is checked by listing models with it; "not-a-key" is turned away.
    const key = request.headers["x-goog-api-key"];
    if (key === "not-a-key") return reply(400, { error: { message: "API key not valid. Please pass a valid API key." } });
    if (request.url.startsWith("/models")) return reply(200, { models: [{ name: "models/gemini-flash-latest" }] });
    if (behaviour === "daily limit") {
        return reply(429, { error: { message: "Rate limit exceeded (limit: 20 requests per day on Free Tier)." } },
            { "retry-after": "46755" });
    }
    const { input = [], stream } = JSON.parse(body || "{}");
    const text = input.find((item) => item.type === "text")?.text ?? "";
    // A page too dense for one answer: the first stops part-way through bar
    // 2; the next starts again at bar 1 and stops part-way through bar 3; the
    // last finishes. Put together, it is Twinkle.
    if (behaviour === "long" || behaviour === "cut") {
        const after = /It stops after measure (\d+)/.exec(text)?.[1] ?? null;
        carriedOn.push(after);
        const at = (n) => twinkle.indexOf(`<measure number="${n}"`);
        const cut = (fields) => JSON.stringify(fields).slice(0, -2); // no closing quote and brace
        const [output, status] = after === null
            ? [cut({ title: "Twinkle", musicxml: twinkle.slice(0, at(2) + 30) }), behaviour === "cut" ? "cut" : "incomplete"]
            : after === "1"
              ? [cut({ rest: twinkle.slice(at(1), at(3) + 30) }), behaviour === "cut" ? "cut" : "incomplete"]
              : [JSON.stringify({ rest: twinkle.slice(at(3)), instrument: "piano", questions: [] }), "completed"];
        return streamed(output, status);
    }
    // Re-reading a bar: bar 1 comes back with its first note a step lower,
    // or - "reread same" - exactly as it was.
    if (text.includes("read wrong.")) {
        rereadAsked.push(/found measures? ([\d, ]+) read wrong/.exec(text)?.[1]);
        // Bar 2 of the misread Twinkle, asked about from its shading: right this time.
        if (/found measure 2 read wrong/.test(text)) {
            return streamed(JSON.stringify({ measures: [{ part: "P1", number: "2", musicxml: bar2 }] }));
        }
        // The bar as it is in the score sent - so "the same" is the same.
        const current = /<measure number="1"[\s\S]*?<\/measure>/.exec(text.slice(text.indexOf("The current MusicXML")))[0];
        const answer = behaviour === "reread same" ? current : current.replace("<step>G</step>", "<step>F</step>");
        return streamed(JSON.stringify({ measures: [{ part: "P1", number: "1", musicxml: answer }] }));
    }
    if (behaviour === "skipping") {
        if (!text.includes("It skips some measures")) {
            return streamed(JSON.stringify({ title: "Twinkle", musicxml: skipping, instrument: "piano", questions: [] }));
        }
        filled.push(/- measures (.*)/.exec(text)?.[1]);
        return streamed(JSON.stringify({ measures: [1, 2].map((n) => ({ part: "P1", number: String(n), musicxml: barOf(n) })) }));
    }
    if (behaviour === "uneven") {
        if (!text.includes("do not add up")) {
            return streamed(JSON.stringify({ title: "Twinkle", musicxml: misread, instrument: "piano", questions: [] }));
        }
        rechecked.push(/Measure (\d+), voice 1: its durations total (\d+)/.exec(text)?.slice(1));
        const fixed = recheckFixes ? bar2 : /<measure number="2"[\s\S]*?<\/measure>/.exec(misread)[0];
        return streamed(JSON.stringify({ measures: [{ part: "P1", number: "2", musicxml: fixed }] }));
    }
    const refining = text.includes("My answers:");
    asked.push({
        refining,
        stream,
        key,
        withImage: input.some((item) => item.type === "image"),
        images: input.filter((item) => item.type === "image").map((item) => item.resolution ?? "default"),
        // Each PNG's width and height, from its header, to tell pages apart.
        sizes: input.filter((item) => item.type === "image" && item.mime_type === "image/png").map((item) => {
            const png = Buffer.from(item.data, "base64");
            return [png.readUInt32BE(16), png.readUInt32BE(20)];
        }),
        strips: /comes as (\d+) images/.exec(text)?.[1] ?? null,
        answer: /My answer: (.*)/.exec(text)?.[1] ?? null,
    });
    const answer = behaviour === "not music"
        ? { title: "A cat", musicxml: "This photo shows a cat, not sheet music.", questions: [] }
        : refining
          ? { title: "Twinkle", musicxml: timing, questions: [] }
          : {
                title: "Twinkle",
                musicxml: twinkle,
                // The reader says the page is for violin; the page has Piano picked.
                instrument: "violin",
                questions: [{ id: "q1", measure: 2, question: "Is bar 2 a tie or a slur?", options: ["Tie", "Slur"] }],
            };
    return streamed(JSON.stringify(answer));

    // Streamed as Gemini streams it: a summary of the thinking straight away,
    // then - 1.5s later, so the page is seen mid-read - the answer.
    async function streamed(output, status = "completed") {
        const event = (e) => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream", ...cors });
        response.write(event({ event_type: "step.start", index: 0, step: { type: "thought" } }));
        response.write(event({ event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { text: "**Reading the Staff**\n\nTreble clef." } } }));
        await sleep(1500);
        response.write(event({ event_type: "step.start", index: 1, step: { type: "model_output" } }));
        response.write(event({ event_type: "step.delta", index: 1, delta: { type: "text", text: output } }));
        // "cut": the stream just stops, as a browser's does at about five minutes.
        if (status === "cut") return response.end();
        response.end(event({ event_type: "interaction.completed", interaction: { model: "stand-in", status } }));
    }
});
reader.listen(0);
await once(reader, "listening");

const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
        ...process.env,
        PORT: String(PORT),
        PROVIDER: "gemini",
        GEMINI_API_KEY: "stand-in",
        GEMINI_MODEL: "",
        GEMINI_API_BASE: `http://localhost:${reader.address().port}`,
        PROOFREAD: "0",
    },
    stdio: ["ignore", "ignore", "inherit"],
});
const browser = spawn(findChrome(), [
    "--headless=new", "--remote-debugging-port=0", "--disable-gpu",
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "read-flow-"))}`,
    // Anything a machine needs, such as --no-sandbox on a CI runner.
    ...(process.env.CHROME_FLAGS ?? "").split(" ").filter(Boolean),
    "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

const errors = [];
try {
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
        await sleep(100);
    }
    let endpoint = null;
    browser.stderr.on("data", (d) => { endpoint ??= /DevTools listening on (ws:\S+)/.exec(String(d))?.[1]; });
    while (!endpoint) await sleep(100);
    let target;
    while (!target) {
        const list = await (await fetch(`http://localhost:${new URL(endpoint).port}/json/list`)).json();
        target = list.find((t) => t.type === "page");
        if (!target) await sleep(100);
    }

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, "open");
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id) return pending.get(message.id)?.(message);
        if (message.method === "Runtime.exceptionThrown") {
            errors.push(message.params.exceptionDetails.exception?.description);
        } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
            errors.push(message.params.args.map((a) => a.value ?? a.description).join(" "));
        }
    });
    const send = (method, params = {}) => {
        const id = ++nextId;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve) => pending.set(id, resolve));
    };
    const evaluate = async (expression) => {
        const { result } = await send("Runtime.evaluate", {
            expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true,
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
        return result.result.value;
    };

    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send("Page.navigate", { url: `http://localhost:${PORT}/` });
    for (let i = 0; i < 100; i++) {
        try { if (await evaluate("return Boolean(window.sheetMusic)")) break; } catch {}
        await sleep(150);
    }

    console.log("\nreading a photo");
    const during = await evaluate(`
        // A real PNG, drawn on a canvas, through the file picker.
        const canvas = document.createElement("canvas");
        canvas.width = 400;
        canvas.height = 200;
        const g = canvas.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, 400, 200);
        const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
        const input = document.getElementById("file");
        const files = new DataTransfer();
        files.items.add(new File([png], "page.png", { type: "image/png" }));
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));

        // The status line, sampled through the read, should only be its clock.
        const seen = new Set();
        for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 100));
            seen.add(document.getElementById("status").textContent.trim().replace(/\\d+:\\d\\d/, "m:ss"));
        }
        return {
            statuses: [...seen],
            locked: ["choose-file", "file"].map((id) => document.getElementById(id).disabled),
        };
    `);
    check("while reading, the status line is only the clock", during.statuses,
        ["Reading your sheet music with Gemini… m:ss — usually one to four minutes"]);
    check("and the upload buttons are locked", during.locked, [true, true]);

    await sleep(2500);
    const read = await evaluate(`
        const questions = document.getElementById("questions");
        return {
            piece: document.getElementById("piece-name").textContent,
            notes: window.sheetMusic.timeline.notes.length,
            asked: !questions.hidden && questions.textContent.includes("tie or a slur"),
            unlocked: !document.getElementById("choose-file").disabled,
        };
    `);
    check("the reading shows", read.piece, "Twinkle — read by Gemini");
    check("and plays", read.notes, 35);
    check("with the reader's question", read.asked, true);
    const instrumentAsked = await evaluate(`
        const card = document.getElementById("instrument-check");
        return card.hidden ? null : document.getElementById("instrument-check-text").textContent;
    `);
    check("and, the reader having seen a violin part, a question about the instrument",
        instrumentAsked, "This looks written for Violin, but Piano is picked.");
    check("and uploads unlocked again", read.unlocked, true);

    console.log("\nanswering its question");
    const answered = await evaluate(`
        const questions = document.getElementById("questions");
        questions.querySelector(".choice").click();
        questions.querySelector(".questions-actions .primary").click();
        await new Promise((r) => setTimeout(r, 300));
        const busy = document.getElementById("status").textContent;
        await new Promise((r) => setTimeout(r, 2500));
        return {
            busy: /applying your answers/.test(busy),
            piece: document.getElementById("piece-name").textContent,
            bpm: window.sheetMusic.timeline.bpm,
            questionsGone: questions.hidden,
        };
    `);
    check("the answer is being applied", answered.busy, true);
    check("the corrected score replaces the first", [answered.piece, answered.bpm], ["Twinkle — corrected", 96]);
    check("and the question is done with", answered.questionsGone, true);

    check("the reader got the photo both times", asked.map((a) => a.withImage), [true, true]);
    check("streamed, so the connection never goes quiet", asked.map((a) => a.stream), [true, true]);
    check("and the answer chosen", asked.map((a) => a.answer), [null, "Tie"]);

    // When a read fails, the page says why, unlocks, and keeps what it had.
    console.log("\nwhen a read fails");
    const failedRead = async () => evaluate(`
        const canvas = document.createElement("canvas");
        canvas.width = 50;
        canvas.height = 50;
        const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
        const input = document.getElementById("file");
        const files = new DataTransfer();
        files.items.add(new File([png], "page.png", { type: "image/png" }));
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const status = document.getElementById("status");
        for (let i = 0; i < 50 && !status.classList.contains("error"); i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        return {
            said: status.textContent,
            unlocked: !document.getElementById("choose-file").disabled,
            stillShowing: document.getElementById("piece-name").textContent,
        };
    `);
    behaviour = "daily limit";
    const limited = await failedRead();
    check("out of daily readings, it says when they come back",
        /used up.*midnight Pacific, in about 13 hours/.test(limited.said), true);
    check("unlocks the uploads", limited.unlocked, true);
    check("and keeps the score that was showing", limited.stillShowing, "Twinkle — corrected");
    behaviour = "not music";
    const notMusic = await failedRead();
    check("a photo that is not music is said to be so", /not.*sheet music/i.test(notMusic.said), true);
    check("and unlocks the uploads", notMusic.unlocked, true);

    console.log("\na page too long for one answer");
    const longRead = () => evaluate(`
        const canvas = document.createElement("canvas");
        canvas.width = 60;
        canvas.height = 60;
        const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
        const input = document.getElementById("file");
        const files = new DataTransfer();
        files.items.add(new File([png], "dense.png", { type: "image/png" }));
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const piece = document.getElementById("piece-name");
        const status = document.getElementById("status");
        const said = new Set();
        // Done when a new score is up, or the read has failed - the piece's
        // name may already say "read by" from the reading before.
        const before = window.sheetMusic.timeline;
        for (let i = 0; i < 200 && window.sheetMusic.timeline === before && !status.classList.contains("error"); i++) {
            await new Promise((r) => setTimeout(r, 100));
            said.add(status.textContent.replace(/\\d+:\\d\\d/, "m:ss"));
        }
        // The status line settles once the score is drawn.
        await new Promise((r) => setTimeout(r, 300));
        return {
            piece: piece.textContent,
            notes: window.sheetMusic.timeline.notes.length,
            said: [...said],
        };
    `);
    console.log("\na page with many systems");
    // Ten systems of staff lines with blank paper between, through the picker.
    const stripsRead = () => evaluate(`
        const c = document.createElement("canvas");
        c.width = 1200; c.height = 1700;
        const g = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, 1200, 1700);
        g.fillStyle = "#000";
        for (let s = 0; s < 10; s++) {
            for (let line = 0; line < 5; line++) g.fillRect(60, 180 + s * 150 + line * 14, 1080, 2);
        }
        const png = await new Promise((r) => c.toBlob(r, "image/png"));
        const input = document.getElementById("file");
        const files = new DataTransfer();
        files.items.add(new File([png], "page.png", { type: "image/png" }));
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        // Done when a new score is up, or the read has failed.
        const before = window.sheetMusic.timeline;
        const status = document.getElementById("status");
        const said = new Set();
        for (let i = 0; i < 200 && window.sheetMusic.timeline === before && !status.classList.contains("error"); i++) {
            await new Promise((r) => setTimeout(r, 100));
            said.add(status.textContent.replace(/\\d+:\\d\\d/, "m:ss"));
        }
        return { piece: document.getElementById("piece-name").textContent, said: [...said] };
    `);
    behaviour = "read";
    const stripCount = asked.length;
    const pagesRead = asked.length + 1;
    const dense = await stripsRead();
    check("is read", dense.piece, "Twinkle — read by Gemini");
    check("saying a dense page takes longer",
        dense.said.includes("Reading your sheet music with Gemini… m:ss — a dense page takes five to ten minutes"), true);
    const sentStrips = asked[stripCount];
    check("from strips, each in full detail", sentStrips.images.length > 1 && sentStrips.images.every((r) => r === "ultra_high"), true);
    check("said to be one page in that many slices", sentStrips.strips, String(sentStrips.images.length));

    console.log("\nseveral pages of one piece");
    const severalRead = await evaluate(`
        // Two small pages, chosen out of order: each too small to cut.
        const page = async (shade) => {
            const c = document.createElement("canvas");
            c.width = 300; c.height = 200;
            const g = c.getContext("2d");
            g.fillStyle = shade; g.fillRect(0, 0, 300, 200);
            return new Promise((r) => c.toBlob(r, "image/png"));
        };
        const input = document.getElementById("file");
        const files = new DataTransfer();
        files.items.add(new File([await page("#eee")], "IMG_0010.png", { type: "image/png" }));
        files.items.add(new File([await page("#fff")], "IMG_0009.png", { type: "image/png" }));
        input.files = files.files;
        const before = window.sheetMusic.timeline;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const status = document.getElementById("status");
        for (let i = 0; i < 200 && window.sheetMusic.timeline === before && !status.classList.contains("error"); i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        return document.getElementById("piece-name").textContent;
    `);
    const both = asked.at(-1);
    check("are read together, into one score", [severalRead, asked.length - stripCount], ["Twinkle — read by Gemini", 2]);
    check("in one request with both pages, said to be in order", [both.images.length, both.strips], [2, "2"]);

    console.log("\nphotos taken page by page");
    const taken = await evaluate(`
        const photo = async (w, h) => {
            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            const g = c.getContext("2d");
            g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
            return new File([await new Promise((r) => c.toBlob(r, "image/png"))], "image.png", { type: "image/png" });
        };
        const camera = document.getElementById("camera");
        const take = async (file) => {
            const files = new DataTransfer();
            files.items.add(file);
            camera.files = files.files;
            camera.dispatchEvent(new Event("change", { bubbles: true }));
            await new Promise((r) => setTimeout(r, 100));
        };
        const tray = document.getElementById("pages-taken");
        const before = window.sheetMusic.timeline;
        await take(await photo(300, 200));
        const one = { shown: !tray.hidden, said: document.getElementById("pages-count").textContent };
        await take(await photo(240, 240));
        await take(await photo(200, 300));
        // The middle one came out blurry: it goes on its own.
        tray.querySelectorAll(".page-remove")[1].click();
        await new Promise((r) => setTimeout(r, 50));
        const two = {
            thumbs: tray.querySelectorAll("img").length,
            button: document.getElementById("read-pages").textContent,
            labels: [...tray.querySelectorAll(".page-remove")].map((b) => b.getAttribute("aria-label")),
        };
        document.getElementById("read-pages").click();
        const status = document.getElementById("status");
        for (let i = 0; i < 200 && window.sheetMusic.timeline === before && !status.classList.contains("error"); i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        return { one, two, emptied: tray.hidden, piece: document.getElementById("piece-name").textContent };
    `);
    check("a photo waits in the tray", [taken.one.shown, /1 page/.test(taken.one.said)], [true, true]);
    check("and the next joins it, and one can be taken out again",
        [taken.two.thumbs, taken.two.button, taken.two.labels], [2, "Read 2 pages", ["Remove page 1", "Remove page 2"]]);
    check("Read sends them as one score", [taken.piece, taken.emptied], ["Twinkle — read by Gemini", true]);
    check("in the order they were taken", asked.at(-1).sizes, [[300, 200], [200, 300]]);

    behaviour = "long";
    carriedOn = [];
    const long = await longRead();
    check("it is read over several answers", carriedOn, [null, "1", "2"]);
    check("and comes out whole", [long.piece, long.notes], ["Twinkle — read by Gemini", 35]);

    console.log("\nreading a bar again");
    const rereadNow = () => evaluate(`
        const button = document.getElementById("reread-bar");
        const offered = !button.hidden && button.textContent;
        const status = document.getElementById("status");
        button.click();
        for (let i = 0; i < 50 && !button.disabled; i++) await new Promise((r) => setTimeout(r, 20));
        for (let i = 0; i < 200 && button.disabled; i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 300));
        const count = (midi) => window.sheetMusic.timeline.notes.filter((n) => n.midi === midi).length;
        return { offered, said: status.textContent, g5: count(79), f5: count(77) };
    `);
    const beforeReread = await evaluate(`
        const count = (midi) => window.sheetMusic.timeline.notes.filter((n) => n.midi === midi).length;
        return { g5: count(79), f5: count(77) };
    `);
    behaviour = "reread";
    rereadAsked = [];
    const corrected = await rereadNow();
    check("a reading offers to read its bar again", corrected.offered, "Re-read bar 1");
    check("which asks about just that bar", rereadAsked, ["1"]);
    check("and puts the corrected bar in", [corrected.said, corrected.g5 - beforeReread.g5, corrected.f5 - beforeReread.f5],
        ["Bar 1 read again and corrected. Press play to hear it.", -1, 1]);
    behaviour = "reread same";
    const unchanged = await rereadNow();
    check("a bar read the same way says so", /read bar 1 the same way again/.test(unchanged.said), true);
    behaviour = "read";

    console.log("\nbars the reading skipped");
    behaviour = "skipping";
    filled = [];
    const refilled = await longRead();
    check("are asked for by number", filled, ["1-2"]);
    check("and put back in place", [refilled.piece, refilled.notes], ["Twinkle — read by Gemini", 35]);

    console.log("\na bar that does not add up");
    behaviour = "uneven";
    rechecked = [];
    recheckFixes = true;
    const evened = await longRead();
    const status = () => evaluate(`return document.getElementById("status").textContent`);
    check("is sent back to be looked at again, saying what it totals", rechecked, [["2", "1680"]]);
    check("and the corrected bar goes in", [evened.piece, evened.notes], ["Twinkle — read by Gemini", 35]);
    check("leaving nothing to warn about", /add up/.test(await status()), false);
    rechecked = [];
    recheckFixes = false;
    await longRead();
    check("a bar the recheck cannot fix is pointed out",
        /Bar 2 does not add up to the time signature/.test(await status()), true);
    check("and shaded on the score", await evaluate(`return document.querySelectorAll("#score .bar-mark").length`), 1);
    rereadAsked = [];
    const shadedAgain = await evaluate(`
        const button = document.getElementById("reread-shaded");
        const offered = !button.hidden && button.textContent;
        button.click();
        for (let i = 0; i < 50 && !button.disabled; i++) await new Promise((r) => setTimeout(r, 20));
        for (let i = 0; i < 200 && button.disabled; i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 300));
        return {
            offered,
            marks: document.querySelectorAll("#score .bar-mark").length,
            stillOffered: !button.hidden,
            said: document.getElementById("status").textContent,
        };
    `);
    check("the shaded bar is offered to be read again", shadedAgain.offered, "Re-read the shaded bar");
    check("which sends that bar back", rereadAsked, ["2"]);
    check("and, read right, it is no longer shaded",
        [shadedAgain.marks, shadedAgain.stillOffered, shadedAgain.said],
        [0, false, "Bar 2 read again and corrected. Press play to hear it."]);
    behaviour = "read";
    // --- the hosted copy, reading with your own key -----------------------
    // The static build, as GitHub Pages serves it: no server, an api/health
    // file saying so, and the page calling the reader itself.
    console.log("\non the hosted copy, with your own key");
    const site = createServer((request, response) => {
        const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
        if (path === "/api/health") {
            response.writeHead(200, { "content-type": "application/json" });
            return response.end('{"ok":true,"canRead":false,"provider":null,"static":true}');
        }
        const file = path.startsWith("/samples/")
            ? join(ROOT, path)
            : join(ROOT, "public", path === "/" ? "index.html" : path);
        try {
            const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".musicxml": "application/xml" };
            response.writeHead(200, { "content-type": types[/\.\w+$/.exec(file)?.[0]] ?? "application/octet-stream" });
            response.end(readFileSync(file));
        } catch {
            response.writeHead(404);
            response.end();
        }
    });
    site.listen(0);
    await once(site, "listening");
    const hosted = `http://localhost:${site.address().port}/`;
    const asksBefore = asked.length;
    behaviour = "read";

    // Point the page's reader at the stand-in, as a proxy would be.
    await send("Page.navigate", { url: hosted });
    await sleep(500);
    await evaluate(`
        localStorage.setItem("gemini-api-base", "http://localhost:${reader.address().port}");
    `);
    await send("Page.navigate", { url: hosted });
    for (let i = 0; i < 100; i++) {
        try { if (await evaluate("return Boolean(window.sheetMusic)")) break; } catch {}
        await sleep(150);
    }
    await sleep(500);

    const offered = await evaluate(`
        return {
            note: !document.getElementById("no-reader").hidden,
            form: Boolean(document.getElementById("key-form")),
            photosOffered: document.getElementById("file").accept.includes("image"),
        };
    `);
    check("the hosted copy offers to read with your own key", [offered.note, offered.form], [true, true]);
    check("and until then does not offer photos", offered.photosOffered, false);

    const saveKey = (key) => evaluate(`
        document.getElementById("key-input").value = ${JSON.stringify(key)};
        document.getElementById("key-form").requestSubmit();
        await new Promise((r) => setTimeout(r, 800));
        return {
            error: document.getElementById("key-error").hidden ? null : document.getElementById("key-error").textContent,
            note: !document.getElementById("no-reader").hidden,
            saved: !document.getElementById("own-key").hidden,
            stored: localStorage.getItem("gemini-key"),
        };
    `);
    const rejected = await saveKey("not-a-key");
    check("a key Google turns down is not saved", [rejected.stored, rejected.saved], [null, false]);
    check("and the page says so", /did not accept that key/.test(rejected.error ?? ""), true);
    const accepted = await saveKey("my-own-key");
    check("a good key is saved in the browser", accepted.stored, "my-own-key");
    check("and the page is ready to read", [accepted.note, accepted.saved], [false, true]);

    const hostedRead = await evaluate(`
        const canvas = document.createElement("canvas");
        canvas.width = 300;
        canvas.height = 150;
        const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
        const input = document.getElementById("file");
        const files = new DataTransfer();
        files.items.add(new File([png], "page.png", { type: "image/png" }));
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const piece = document.getElementById("piece-name");
        // Part-way through, the status line says what the model is thinking about.
        await new Promise((r) => setTimeout(r, 700));
        const midway = document.getElementById("status").textContent;
        for (let i = 0; i < 60 && !/read by/.test(piece.textContent); i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        const questions = document.getElementById("questions");
        const out = { piece: piece.textContent, asked: !questions.hidden, midway };
        questions.querySelector(".choice").click();
        questions.querySelector(".questions-actions .primary").click();
        for (let i = 0; i < 60 && !/corrected/.test(piece.textContent); i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        out.corrected = piece.textContent;
        out.bpm = window.sheetMusic.timeline.bpm;
        return out;
    `);
    const fromPage = asked.slice(asksBefore);
    check("while it reads, the page shows what the model is thinking about", /— Reading the Staff$/.test(hostedRead.midway), true);
    check("a photo is read in the page", hostedRead.piece, "Twinkle — read by Gemini");
    check("with the reader's question", hostedRead.asked, true);
    check("and the answer applied", [hostedRead.corrected, hostedRead.bpm], ["Twinkle — corrected", 96]);
    check("the page sent the photo, with your key, streamed",
        fromPage.map((a) => [a.withImage, a.key, a.stream]), [[true, "my-own-key", true], [true, "my-own-key", true]]);

    behaviour = "long";
    carriedOn = [];
    const longHere = await longRead();
    check("a page too long for one answer is read over several here too", carriedOn, [null, "1", "2"]);
    check("and comes out whole", [longHere.piece, longHere.notes], ["Twinkle — read by Gemini", 35]);
    check("saying which bar it is carrying on after",
        longHere.said.some((s) => /— carrying on after bar 2 · Reading the Staff$/.test(s)), true);
    behaviour = "cut";
    carriedOn = [];
    const cutHere = await longRead();
    check("a stream cut part-way here is carried on from what it wrote", carriedOn, [null, "1", "2"]);
    check("and comes out whole", [cutHere.piece, cutHere.notes], ["Twinkle — read by Gemini", 35]);

    behaviour = "uneven";
    rechecked = [];
    recheckFixes = true;
    const evenedHere = await longRead();
    check("a bar that does not add up is rechecked here too", [rechecked.length, evenedHere.notes], [1, 35]);
    check("saying so while it does",
        evenedHere.said.some((s) => /— rechecking 1 bar that did not add up · Reading the Staff$/.test(s)), true);
    behaviour = "read";

    // The key is remembered on the next visit, and can be forgotten.
    await send("Page.navigate", { url: hosted });
    for (let i = 0; i < 100; i++) {
        try { if (await evaluate("return Boolean(window.sheetMusic)")) break; } catch {}
        await sleep(150);
    }
    await sleep(500);
    const remembered = await evaluate(`
        const out = { saved: !document.getElementById("own-key").hidden };
        document.getElementById("forget-key").click();
        out.forgotten = localStorage.getItem("gemini-key") === null && !document.getElementById("no-reader").hidden;
        return out;
    `);
    check("the key is remembered on the next visit", remembered.saved, true);
    check("and Forget it removes it", remembered.forgotten, true);
    site.close();

    // The two failed reads log their reason, as intended; nothing else may.
    check("no other errors in the page",
        errors.filter((e) => !/used up|not return a MusicXML|not.*sheet music/i.test(e)), []);
} finally {
    browser.kill("SIGKILL");
    server.kill();
    reader.close();
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
