// Measures how accurately a page of sheet music is read back.
//
// The existing transcribe check proves the MusicXML that comes back is valid
// and plays. It does not prove it is the same music. This renders a sample
// whose notes are known exactly, photographs the engraving, sends the picture
// through the reader, and diffs the result against the original note by note.
//
//   npm run test:accuracy                  # all samples
//   npm run test:accuracy -- twinkle       # one of them
//
// Needs an API key. On Gemini's free tier this costs nothing to run.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.TEST_PORT ?? 3114);
const ROOT = new URL("..", import.meta.url).pathname;

/** What each sample is for, and the instrument to read it as. */
const SAMPLES = [
    { name: "twinkle", instrument: "piano", note: "two staves, chords" },
    { name: "timing-test", instrument: "flute", note: "dots, triplet, tie, repeat, 6/8" },
];

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const chosen = wanted.length ? SAMPLES.filter((s) => wanted.includes(s.name)) : SAMPLES;

/** Below this, reading an engraved page is not working. */
const PITCH_FLOOR = 0.9;
const RHYTHM_FLOOR = 0.85;

if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("No API key set. Put GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.");
    process.exit(2);
}

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Compares two note lists. Times are in beats, not seconds, so that a tempo
 * misread does not masquerade as every note being wrong - tempo is reported
 * separately.
 */
function compare(original, read) {
    const pairs = Math.min(original.length, read.length);
    let pitch = 0;
    let onset = 0;
    let duration = 0;
    const wrong = [];

    for (let i = 0; i < pairs; i++) {
        const a = original[i];
        const b = read[i];
        const samePitch = a.midi === b.midi;
        const sameOnset = Math.abs(a.beat - b.beat) < 0.05;
        const sameLength = Math.abs(a.beats - b.beats) < 0.05;

        if (samePitch) pitch += 1;
        if (sameOnset) onset += 1;
        if (sameLength) duration += 1;
        if ((!samePitch || !sameLength) && wrong.length < 6) {
            wrong.push(
                `#${i + 1} expected ${a.midi}@${a.beat.toFixed(2)}×${a.beats.toFixed(2)}` +
                    ` got ${b.midi}@${b.beat.toFixed(2)}×${b.beats.toFixed(2)}`,
            );
        }
    }

    return {
        expected: original.length,
        got: read.length,
        pitch: pairs ? pitch / pairs : 0,
        onset: pairs ? onset / pairs : 0,
        duration: pairs ? duration / pairs : 0,
        wrong,
    };
}

async function main() {
    const server = spawn(process.execPath, ["server.js"], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ["ignore", "ignore", "inherit"],
    });
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
        await sleep(100);
    }

    const browser = spawn(
        findChrome(),
        ["--headless=new", "--remote-debugging-port=0", "--disable-gpu", "--no-first-run",
         "--hide-scrollbars", `--user-data-dir=${join(tmpdir(), `acc-${process.pid}`)}`,
         `http://localhost:${PORT}/`],
        { stdio: ["ignore", "pipe", "pipe"] },
    );
    let endpoint = null;
    browser.stderr.on("data", (d) => {
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
        if (m) endpoint = m[1];
    });
    while (!endpoint) await sleep(100);

    const port = new URL(endpoint).port;
    let target;
    while (!target) {
        const list = await (await fetch(`http://localhost:${port}/json/list`)).json();
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (!target) await sleep(100);
    }

    const page = await DevTools.connect(target.webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    for (let i = 0; i < 150; i++) {
        try { if (await page.evaluate("return Boolean(window.sheetMusic)")) break; } catch {}
        await sleep(150);
    }

    try {
        for (const sample of chosen) {
            console.log(`\n${sample.name}.musicxml (${sample.note})`);

            // 1. Render the original and remember exactly what it contains.
            const original = await page.evaluate(`
                const xml = await (await fetch("samples/${sample.name}.musicxml")).text();
                // Loading the score directly skips the app code that reveals the
                // section, and a hidden container has no layout box to photograph.
                document.getElementById("score").hidden = false;
                document.getElementById("roll").hidden = true;
                document.getElementById("setup-wrap").style.display = "none";
                document.getElementById("controls").style.display = "none";
                const t = await window.sheetMusic.score.load(xml);
                await new Promise((r) => requestAnimationFrame(r));
                const perBeat = 60 / t.bpm;
                return {
                    bpm: t.scoreBpm,
                    notes: t.notes
                        .map((n) => ({ midi: n.midi, beat: n.time / perBeat, beats: n.duration / perBeat }))
                        .sort((a, b) => a.beat - b.beat || a.midi - b.midi),
                };
            `);

            // 2. Photograph the engraving.
            const box = await page.evaluate(`
                const svg = document.querySelector("#score svg");
                const r = svg.getBoundingClientRect();
                return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
            `);
            const shot = await page.send("Page.captureScreenshot", {
                format: "png",
                captureBeyondViewport: true,
                clip: { ...box, scale: 2 },
            });
            const image = Buffer.from(shot.data, "base64");

            // 3. Read it back.
            const form = new FormData();
            form.append("file", new Blob([image], { type: "image/png" }), `${sample.name}.png`);
            form.append("instrument", sample.instrument);
            const started = Date.now();
            const response = await fetch(`http://localhost:${PORT}/api/transcribe`, {
                method: "POST",
                body: form,
            });
            const result = await response.json();
            const seconds = ((Date.now() - started) / 1000).toFixed(0);

            if (!response.ok) {
                console.log(`  FAIL read (${seconds}s): ${result.error}`);
                failures += 1;
                continue;
            }

            const xmlPath = join(tmpdir(), `${sample.name}-read.musicxml`);
            writeFileSync(xmlPath, result.musicxml);

            // 4. Turn what came back into notes, the same way.
            const read = await page.evaluate(`
                document.getElementById("score").hidden = false;
                const t = await window.sheetMusic.score.load(${JSON.stringify(result.musicxml)});
                const perBeat = 60 / t.bpm;
                return {
                    bpm: t.scoreBpm,
                    notes: t.notes
                        .map((n) => ({ midi: n.midi, beat: n.time / perBeat, beats: n.duration / perBeat }))
                        .sort((a, b) => a.beat - b.beat || a.midi - b.midi),
                };
            `);

            const diff = compare(original.notes, read.notes);
            const pct = (n) => `${Math.round(n * 100)}%`;
            console.log(`  read in ${seconds}s, ${result.questions.length} question(s)`);
            console.log(`  notes      ${diff.got} read vs ${diff.expected} written`);
            console.log(`  pitches    ${pct(diff.pitch)}`);
            console.log(`  onsets     ${pct(diff.onset)}`);
            console.log(`  lengths    ${pct(diff.duration)}`);
            console.log(`  tempo      ${read.bpm ?? "none"} vs ${original.bpm ?? "none"}`);
            for (const line of diff.wrong) console.log(`    ${line}`);
            console.log(`  saved to ${xmlPath}`);

            if (diff.got !== diff.expected) {
                console.log(`  FAIL note count differs`);
                failures += 1;
            }
            if (diff.pitch < PITCH_FLOOR) {
                console.log(`  FAIL pitches below ${pct(PITCH_FLOOR)}`);
                failures += 1;
            }
            if (diff.duration < RHYTHM_FLOOR) {
                console.log(`  FAIL lengths below ${pct(RHYTHM_FLOOR)}`);
                failures += 1;
            }
        }
    } finally {
        browser.kill();
        server.kill();
    }

    console.log(failures === 0 ? "\nReading is accurate." : `\n${failures} problem(s).`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
