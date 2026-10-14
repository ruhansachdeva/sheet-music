// End-to-end test of the Claude path, without needing a photo of real sheet
// music: it renders one of the samples in a headless browser, screenshots the
// engraving, and posts that image to /api/transcribe as if you had photographed
// it. Then it loads the MusicXML that comes back and checks it plays.
//
//   npm run test:claude                       # twinkle
//   npm run test:claude -- timing-test        # another sample
//   npm run test:claude -- twinkle --answer   # also answer any questions
//
// This one costs money: it makes one or two real Claude requests.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.TEST_PORT ?? 3112);
const ROOT = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const SAMPLE = (args.find((a) => !a.startsWith("--")) ?? "twinkle").replace(/\.musicxml$/, "");
const ANSWER = args.includes("--answer");

if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in .env (see .env.example).");
    process.exit(2);
}

let failures = 0;
function check(label, ok, detail = "") {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures += 1;
}

function findChrome() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const cache = join(homedir(), "Library/Caches/ms-playwright");
    if (existsSync(cache)) {
        for (const dir of readdirSync(cache)) {
            for (const candidate of [
                join(cache, dir, "chrome-headless-shell-mac-arm64/chrome-headless-shell"),
                join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
            ]) {
                if (existsSync(candidate)) return candidate;
            }
        }
    }
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(chrome)) return chrome;
    throw new Error("No Chromium found. Set CHROME_PATH.");
}

class DevTools {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
            const waiting = this.pending.get(message.id);
            if (!waiting) return;
            this.pending.delete(message.id);
            if (message.error) waiting.reject(new Error(message.error.message));
            else waiting.resolve(message.result);
        });
    }

    static async connect(url) {
        const socket = new WebSocket(url);
        await once(socket, "open");
        return new DevTools(socket);
    }

    send(method, params = {}) {
        const id = this.nextId++;
        this.socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    async evaluate(expression) {
        const result = await this.send("Runtime.evaluate", {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
        }
        return result.result.value;
    }
}

async function waitFor(probe, { timeout = 30000, what = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            if (await probe()) return;
        } catch {
            // keep waiting
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

async function main() {
    const server = spawn(process.execPath, ["server.js"], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ["ignore", "ignore", "inherit"],
    });
    await waitFor(async () => (await fetch(`http://localhost:${PORT}/`)).ok, {
        what: "the server",
    });

    const profile = join(tmpdir(), `sheet-music-claude-${process.pid}`);
    const browser = spawn(
        findChrome(),
        [
            "--headless=new",
            "--remote-debugging-port=0",
            "--disable-gpu",
            "--no-first-run",
            "--hide-scrollbars",
            `--user-data-dir=${profile}`,
            `http://localhost:${PORT}/`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
    );

    let endpoint = null;
    browser.stderr.on("data", (data) => {
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(String(data));
        if (match) endpoint = match[1];
    });
    await waitFor(() => endpoint, { what: "Chrome" });

    const port = new URL(endpoint).port;
    let target;
    await waitFor(
        async () => {
            const list = await (await fetch(`http://localhost:${port}/json/list`)).json();
            target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
            return target;
        },
        { what: "a page" },
    );

    const page = await DevTools.connect(target.webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    await page.send("Page.enable");

    try {
        // 1. Render the sample and photograph the engraving.
        await waitFor(() => page.evaluate("return Boolean(window.sheetMusic)"), {
            what: "the app",
        });
        await page.evaluate(`
            await window.sheetMusic.loadSample("${SAMPLE}.musicxml");
            document.getElementById("setup").style.display = "none";
            document.getElementById("controls").style.display = "none";
            await new Promise((r) => requestAnimationFrame(r));
        `);

        const box = await page.evaluate(`
            const svg = document.querySelector("#score svg");
            const r = svg.getBoundingClientRect();
            return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
        `);

        const shot = await page.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: { ...box, scale: 2 }, // 2x, so small print stays legible
        });
        const image = Buffer.from(shot.data, "base64");
        const imagePath = join(tmpdir(), `${SAMPLE}-render.png`);
        writeFileSync(imagePath, image);
        console.log(`\nPhotographed ${SAMPLE}.musicxml -> ${imagePath} (${image.length} bytes)`);

        // 2. Send it through the real transcription path.
        console.log("\nPOST /api/transcribe (this is the part that costs money)");
        const form = new FormData();
        form.append("file", new Blob([image], { type: "image/png" }), `${SAMPLE}.png`);
        form.append("instrument", "piano");

        const started = Date.now();
        const response = await fetch(`http://localhost:${PORT}/api/transcribe`, {
            method: "POST",
            body: form,
        });
        const result = await response.json();
        const seconds = ((Date.now() - started) / 1000).toFixed(1);

        if (!response.ok) {
            check(`transcribe (${seconds}s)`, false, result.error);
            return;
        }

        console.log(`  took ${seconds}s`);
        check("returned a title", Boolean(result.title), result.title);
        check("returned MusicXML", result.musicxml?.includes("<score-partwise"));
        check("questions is an array", Array.isArray(result.questions));
        console.log(`  ${result.questions.length} question(s)`);
        for (const question of result.questions) {
            console.log(`    m.${question.measure} ${question.question}`);
            console.log(`      options: ${question.options.join(" | ")}`);
        }

        // 3. The MusicXML must load, render and produce a playable timeline.
        const loaded = await page.evaluate(`
            const xml = ${JSON.stringify(result.musicxml)};
            const summary = { error: null };
            try {
                const timeline = await window.sheetMusic.score.load(xml);
                window.sheetMusic.player.setTimeline(timeline);
                summary.notes = timeline.notes.length;
                summary.steps = timeline.steps.length;
                summary.bpm = timeline.bpm;
                summary.duration = timeline.duration;
                summary.measures = timeline.measureCount;
            } catch (error) {
                summary.error = String(error);
            }
            return summary;
        `);

        check("Claude's MusicXML renders", !loaded.error, loaded.error ?? "");
        check("and has notes to play", loaded.notes > 0, `${loaded.notes} notes`);
        check("and a sensible length", loaded.duration > 0, `${loaded.duration?.toFixed(2)}s`);
        console.log(
            `  ${loaded.measures} measures, ${loaded.steps} cursor steps, tempo ${loaded.bpm} BPM`,
        );

        // Hold Claude's output to the same rule as the samples: every measure
        // must add up to its time signature.
        const xmlPath = join(tmpdir(), `${SAMPLE}-claude.musicxml`);
        writeFileSync(xmlPath, result.musicxml);
        const verdict = spawn(process.execPath, ["tools/check-musicxml.mjs", xmlPath], {
            cwd: ROOT,
            stdio: "inherit",
        });
        const [code] = await once(verdict, "exit");
        check("every measure adds up", code === 0, `saved to ${xmlPath}`);

        // 4. Optionally answer the questions and check the correction round.
        if (ANSWER && result.questions.length > 0) {
            console.log("\nPOST /api/refine with answers to every question");
            const answers = result.questions.map((question) => ({
                question: question.question,
                answer: question.options[0],
            }));

            const refineForm = new FormData();
            refineForm.append("file", new Blob([image], { type: "image/png" }), `${SAMPLE}.png`);
            refineForm.append("instrument", "piano");
            refineForm.append("musicxml", result.musicxml);
            refineForm.append("answers", JSON.stringify(answers));

            const refined = await fetch(`http://localhost:${PORT}/api/refine`, {
                method: "POST",
                body: refineForm,
            });
            const corrected = await refined.json();
            check("refine returned MusicXML", corrected.musicxml?.includes("<score-partwise"));
            check("refine returned questions", Array.isArray(corrected.questions));
        } else if (ANSWER) {
            console.log("\nNo questions to answer, so /api/refine was not exercised.");
        }
    } finally {
        browser.kill();
        server.kill();
    }

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
