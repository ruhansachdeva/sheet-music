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
    let body = "";
    for await (const chunk of request) body += chunk;
    if (behaviour === "daily limit") {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "46755" });
        response.end(JSON.stringify({ error: { message: "Rate limit exceeded (limit: 20 requests per day on Free Tier)." } }));
        return;
    }
    if (behaviour === "not music") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text",
            text: JSON.stringify({ title: "A cat", musicxml: "This photo shows a cat, not sheet music.", questions: [] }) }] }] }));
        return;
    }
    const { input = [] } = JSON.parse(body || "{}");
    const text = input.find((item) => item.type === "text")?.text ?? "";
    const refining = text.includes("My answers:");
    asked.push({
        refining,
        withImage: input.some((item) => item.type === "image"),
        answer: /My answer: (.*)/.exec(text)?.[1] ?? null,
    });
    // Long enough that the page is seen mid-read.
    await sleep(1500);
    const reply = refining
        ? { title: "Twinkle", musicxml: timing, questions: [] }
        : {
              title: "Twinkle",
              musicxml: twinkle,
              questions: [{ id: "q1", measure: 2, question: "Is bar 2 a tie or a slur?", options: ["Tie", "Slur"] }],
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
        status: "completed",
        model: "stand-in",
        steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(reply) }] }],
    }));
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
        ["Reading your sheet music with Gemini… m:ss — usually one to three minutes"]);
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
