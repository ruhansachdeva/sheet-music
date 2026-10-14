// Loads each sample in a real headless browser and checks the timeline the
// timing engine produces: note starts and lengths, tied notes, triplets,
// unrolled repeats, cursor steps and the metronome grid.
//
//   node tools/browser-test.mjs            # timeline checks
//   node tools/browser-test.mjs --audio    # also start playback and watch the clock
//
// It needs a Chromium binary. It looks for Playwright's cached one, or set
// CHROME_PATH to any Chrome or Chromium.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.TEST_PORT ?? 3111);
const WITH_AUDIO = process.argv.includes("--audio");
const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;

function check(label, actual, expected, tolerance = 1e-3) {
    const ok =
        typeof expected === "number"
            ? Math.abs(actual - expected) <= tolerance
            : JSON.stringify(actual) === JSON.stringify(expected);

    console.log(
        `  ${ok ? "ok  " : "FAIL"} ${label}: ${format(actual)}${ok ? "" : ` (expected ${format(expected)})`}`,
    );
    if (!ok) failures += 1;
}

function format(value) {
    return typeof value === "number" ? Number(value.toFixed(4)) : JSON.stringify(value);
}

// --- finding a browser ------------------------------------------------------

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

// --- a minimal Chrome DevTools Protocol client ------------------------------

class DevTools {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        this.logs = [];

        socket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) reject(new Error(message.error.message));
                else resolve(message.result);
                return;
            }
            this.note(message);
        });
    }

    static async connect(url) {
        const socket = new WebSocket(url);
        await once(socket, "open");
        return new DevTools(socket);
    }

    note(message) {
        if (message.method === "Runtime.consoleAPICalled") {
            const text = (message.params.args ?? [])
                .map((arg) => arg.value ?? arg.description ?? arg.type)
                .join(" ");
            this.logs.push({ level: message.params.type, text });
        } else if (message.method === "Runtime.exceptionThrown") {
            const details = message.params.exceptionDetails;
            this.logs.push({
                level: "exception",
                text: details.exception?.description ?? details.text,
            });
        } else if (message.method === "Log.entryAdded") {
            const entry = message.params.entry;
            this.logs.push({
                level: entry.level,
                text: entry.url ? `${entry.text} <${entry.url}>` : entry.text,
            });
        }
    }

    send(method, params = {}) {
        const id = this.nextId++;
        this.socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    /** Evaluates an async expression in the page and returns its value. */
    async evaluate(expression) {
        const result = await this.send("Runtime.evaluate", {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            throw new Error(
                result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
            );
        }
        return result.result.value;
    }

    problems() {
        return this.logs.filter(
            (log) =>
                ["error", "exception"].includes(log.level) &&
                // The soundfont CDN has no favicon; harmless.
                !log.text.includes("favicon"),
        );
    }
}

// --- harness ----------------------------------------------------------------

async function waitFor(probe, { timeout = 20000, interval = 100, what = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            if (await probe()) return;
        } catch {
            // Not ready yet.
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

async function startServer() {
    const server = spawn(process.execPath, ["server.js"], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", () => {});
    server.stderr.on("data", (data) => process.stderr.write(`[server] ${data}`));

    await waitFor(async () => (await fetch(`http://localhost:${PORT}/`)).ok, {
        what: "the server to listen",
    });
    return server;
}

async function startBrowser(url) {
    const browser = spawn(
        findChrome(),
        [
            "--headless=new",
            "--remote-debugging-port=0",
            "--disable-gpu",
            "--no-first-run",
            "--autoplay-policy=no-user-gesture-required",
            "--user-data-dir=" + join(process.env.TMPDIR ?? "/tmp", `sheet-music-test-${process.pid}`),
            url,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
    );

    let endpoint = null;
    browser.stderr.on("data", (data) => {
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(String(data));
        if (match) endpoint = match[1];
    });

    await waitFor(() => endpoint, { what: "Chrome to report its debugging port" });
    const port = new URL(endpoint).port;

    // Find the tab Chrome opened for our URL.
    let target = null;
    await waitFor(
        async () => {
            const targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
            target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
            return target;
        },
        { what: "a page target" },
    );

    return { browser, target };
}

// --- the checks -------------------------------------------------------------

/** Pulls the timeline out of the page in a form that is easy to assert on. */
const SUMMARISE = `
    const t = window.sheetMusic.timeline;
    const round = (n) => Math.round(n * 1e6) / 1e6;
    const counted = (values) => {
        const out = {};
        for (const v of values) out[round(v)] = (out[round(v)] ?? 0) + 1;
        return out;
    };
    return {
        bpm: t.bpm,
        scoreBpm: t.scoreBpm,
        duration: t.duration,
        noteCount: t.notes.length,
        stepCount: t.steps.length,
        beatCount: t.beats.length,
        accentCount: t.beats.filter((b) => b.accent).length,
        countIn: t.countIn.map((b) => round(b.time)),
        firstNotes: t.notes.slice(0, 6).map((n) => [n.midi, round(n.time), round(n.duration)]),
        durations: counted(t.notes.map((n) => n.duration)),
        drumKeys: counted(t.notes.filter((n) => n.drumKey !== null).map((n) => n.drumKey)),
        firstBeats: t.beats.slice(0, 7).map((b) => round(b.time)),
        stepTimes: t.steps.slice(0, 5).map((s) => round(s.time)),
    };
`;

async function loadSample(page, name) {
    await page.evaluate(`
        await window.sheetMusic.loadSample(${JSON.stringify(name)});
        await new Promise((r) => requestAnimationFrame(r));
    `);
    return page.evaluate(SUMMARISE);
}

async function run() {
    const server = await startServer();
    let browser;

    try {
        const started = await startBrowser(`http://localhost:${PORT}/`);
        browser = started.browser;
        const page = await DevTools.connect(started.target.webSocketDebuggerUrl);

        await page.send("Runtime.enable");
        await page.send("Log.enable");
        await page.send("Page.enable");
        await waitFor(() => page.evaluate("return Boolean(window.sheetMusic)"), {
            what: "the app to boot",
        });

        const quarter96 = 60 / 96;
        const quarter100 = 60 / 100;

        // --- timing-test: dots, triplets, a tie, a repeat, 6/8 -------------
        console.log("\ntiming-test.musicxml (96 BPM, repeat of bars 1-4, then 6/8)");
        const timing = await loadSample(page, "timing-test.musicxml");

        check("score tempo", timing.scoreBpm, 96);
        // 10 measures as played: 4 + 4 again + 2 in 6/8.
        check("duration", timing.duration, 8 * 4 * quarter96 + 2 * 3 * quarter96);
        check("notes (13 per pass x2, then 8)", timing.noteCount, 34);
        check("cursor steps (15 per pass x2, then 8)", timing.stepCount, 38);
        check("metronome beats (16 x2 + 6 x2)", timing.beatCount, 44);
        check("accented beats, one per measure", timing.accentCount, 10);
        check("count-in is four clicks", timing.countIn, [
            -4 * quarter96,
            -3 * quarter96,
            -2 * quarter96,
            -1 * quarter96,
        ]);
        check("dotted quarter then eighth then quarter", timing.firstNotes.slice(0, 3), [
            [72, 0, 1.5 * quarter96],
            [74, 1.5 * quarter96, 0.5 * quarter96],
            [76, 2 * quarter96, quarter96],
        ]);
        check(
            "six triplet eighths at a third of a beat",
            timing.durations[Math.round((quarter96 / 3) * 1e6) / 1e6],
            6,
        );
        check(
            "two tied F5s sounding a whole note",
            timing.durations[Math.round(4 * quarter96 * 1e6) / 1e6],
            2,
        );
        check("the repeat jumps back to bar 1", timing.stepTimes[0], 0);

        // --- twinkle: two staves, chords ------------------------------------
        console.log("\ntwinkle.musicxml (100 BPM, two staves)");
        const twinkle = await loadSample(page, "twinkle.musicxml");
        check("score tempo", twinkle.scoreBpm, 100);
        check("duration is four 4/4 bars", twinkle.duration, 16 * quarter100);
        check("notes across both staves", twinkle.noteCount, 35);
        check("cursor steps", twinkle.stepCount, 14);
        check("metronome beats", twinkle.beatCount, 16);
        check("melody and bass start together", twinkle.firstNotes[0][1], 0);

        // --- drum groove: unpitched notes mapped to drum sounds -------------
        console.log("\ndrum-groove.musicxml (percussion staff)");
        const drums = await loadSample(page, "drum-groove.musicxml");
        check("notes", drums.noteCount, 25);
        check("every note is a drum", Object.values(drums.drumKeys).reduce((a, b) => a + b, 0), 25);
        check("kick (36) hits", drums.drumKeys[36], 5);
        check("snare (38) hits", drums.drumKeys[38], 4);
        check("closed hi-hat (42) hits", drums.drumKeys[42], 15);
        check("crash (49) hits", drums.drumKeys[49], 1);

        // --- MIDI file: piano roll, channel 10 drums -------------------------
        console.log("\ngroove.mid (120 BPM, scale plus a drum track)");
        const midi = await loadSample(page, "groove.mid");
        check("tempo from the MIDI header", midi.scoreBpm, 120);
        check("notes", midi.noteCount, 32);
        check("no cursor steps for a piano roll", midi.stepCount, 0);
        check("drum notes from channel 10", Object.values(midi.drumKeys).reduce((a, b) => a + b, 0), 24);
        check("beats at 120 BPM", midi.firstBeats.slice(0, 3), [0, 0.5, 1]);
        check(
            "piano roll drawn",
            await page.evaluate("return document.querySelectorAll('.roll-note').length"),
            32,
        );

        // --- rendering ------------------------------------------------------
        console.log("\nrendering");
        await loadSample(page, "twinkle.musicxml");
        check(
            "the score renders as SVG",
            await page.evaluate("return document.querySelectorAll('#score svg').length > 0"),
            true,
        );
        check(
            "notes light up under the cursor",
            await page.evaluate(`
                window.sheetMusic.score.showStep(2);
                return document.querySelectorAll('.note-lit').length > 0;
            `),
            true,
        );

        // --- optional: real playback ----------------------------------------
        if (WITH_AUDIO) {
            console.log("\nplayback (audio clock)");
            const played = await page.evaluate(`
                const { player, score } = window.sheetMusic;
                player.setOption("metronome", true);
                await player.play();
                await new Promise((r) => setTimeout(r, 1200));
                const position = player.position();
                const step = score.stepIndex;
                player.stop();
                return { position, step, state: player.state };
            `);
            check("the audio clock advanced about a second", played.position > 0.8, true);
            check("the cursor moved with it", played.step > 0, true);
            check("stop resets the transport", played.state, "stopped");
        }

        const problems = page.problems();
        console.log(`\nconsole errors: ${problems.length}`);
        for (const problem of problems) console.log(`  ${problem.level}: ${problem.text}`);
        failures += problems.length;
    } finally {
        browser?.kill();
        server.kill();
    }

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
