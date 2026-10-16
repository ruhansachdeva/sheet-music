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
    const refining = text.includes("My answers:");
    asked.push({
        refining,
        stream,
        key,
        withImage: input.some((item) => item.type === "image"),
        answer: /My answer: (.*)/.exec(text)?.[1] ?? null,
    });
    const answer = behaviour === "not music"
        ? { title: "A cat", musicxml: "This photo shows a cat, not sheet music.", questions: [] }
        : refining
          ? { title: "Twinkle", musicxml: timing, questions: [] }
          : {
                title: "Twinkle",
                musicxml: twinkle,
                questions: [{ id: "q1", measure: 2, question: "Is bar 2 a tie or a slur?", options: ["Tie", "Slur"] }],
            };
    // Streamed as Gemini streams it: a summary of the thinking straight away,
    // then - 1.5s later, so the page is seen mid-read - the answer.
    const event = (e) => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream", ...cors });
    response.write(event({ event_type: "step.start", index: 0, step: { type: "thought" } }));
    response.write(event({ event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { text: "**Reading the Staff**\n\nTreble clef." } } }));
    await sleep(1500);
    response.write(event({ event_type: "step.start", index: 1, step: { type: "model_output" } }));
    response.write(event({ event_type: "step.delta", index: 1, delta: { type: "text", text: JSON.stringify(answer) } }));
    response.end(event({ event_type: "interaction.completed", interaction: { model: "stand-in", status: "completed" } }));
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
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "read-flow-"))}`, "about:blank",
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
