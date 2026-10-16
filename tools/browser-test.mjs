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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
        /** Errors a check deliberately provokes, so they are not failures. */
        this.expected = [];

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
        // A call the browser never answers - a tap that opened a native popup,
        // say - fails the run with a reason instead of hanging it for good.
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                const what = params.expression?.replace(/\s+/g, " ").slice(0, 160) ?? "";
                reject(new Error(`DevTools ${method} got no answer in 120s ${what}`));
            }, 120000);
            this.pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
        });
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

    expect(pattern) {
        this.expected.push(pattern);
    }

    problems() {
        return this.logs.filter(
            (log) =>
                ["error", "exception"].includes(log.level) &&
                !log.text.includes("favicon") &&
                !this.expected.some((pattern) => pattern.test(log.text)),
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
        // A timer, not an animation frame: a tab sent to the background - by a
        // link opening another, say - gets no frames, and the wait never ends.
        await new Promise((r) => setTimeout(r, 50));
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
        // Pin the colour scheme. Left alone, headless Chrome follows the host's
        // appearance, so the same run tested the light theme by day and the
        // dark theme by night - and a light-mode regression could hide.
        // Buttons fade their colours over 0.15s, so wait for that to finish:
        // an audit taken mid-fade samples colours that are never really shown.
        const scheme = async (value) => {
            await page.send("Emulation.setEmulatedMedia", {
                features: [{ name: "prefers-color-scheme", value }],
            });
            await new Promise((resolve) => setTimeout(resolve, 400));
        };
        await scheme("light");
        await waitFor(() => page.evaluate("return Boolean(window.sheetMusic)"), {
            what: "the app to boot",
        });

        // axe-core, the standard automated accessibility checker. The first
        // audit runs on the untouched first-run page: later sections change the
        // page enough that a contrast failure can go unseen mid-suite.
        await page.evaluate(`
            await new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
                script.onload = resolve;
                script.onerror = () => reject(new Error("could not load axe-core"));
                document.head.appendChild(script);
            });
        `);
        const auditNow = () => page.evaluate(`
            const result = await axe.run(document, { resultTypes: ["violations"] });
            // Name the elements, so a failure says where to look.
            return result.violations.map((v) => v.id + " (" + v.impact + "): " +
                v.nodes.map((n) => n.target.join(" ") + " - " + (n.any[0]?.message ?? "")).join("; "));
        `);
        console.log("\naccessibility, first run");
        check("no violations on the first-run page, light", await auditNow(), []);
        await scheme("dark");
        check("no violations on the first-run page, dark", await auditNow(), []);
        await scheme("light");

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
        // The roll is stretched to fit; its octave labels must not be.
        await page.send("Emulation.setDeviceMetricsOverride", {
            width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
        });
        const labels = await page.evaluate(`
            await new Promise((r) => setTimeout(r, 300));
            return [...document.querySelectorAll(".roll-label")].map((label) => ({
                text: label.textContent,
                tall: Math.round(label.getBoundingClientRect().height),
            }));
        `);
        await page.send("Emulation.clearDeviceMetricsOverride");
        check("octave labels on the roll", labels.map((l) => l.text), ["C2", "C3", "C4", "C5"]);
        check("readable on a phone, not squashed to a few pixels", labels.every((l) => l.tall >= 10), true);

        // A MIDI file with no tempo event plays at the standard's 120 BPM, and
        // one at 62.5 BPM is not rounded: the slider has to match the sound.
        const midiTempo = async (bpm) => page.evaluate(`
            const { Midi } = await import("https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/+esm");
            const midi = new Midi();
            ${bpm ? `midi.header.setTempo(${bpm});` : ""}
            const track = midi.addTrack();
            track.addNote({ midi: 60, ticks: 0, durationTicks: midi.header.ppq });
            track.addNote({ midi: 62, ticks: midi.header.ppq, durationTicks: midi.header.ppq });
            const input = document.getElementById("file");
            const files = new DataTransfer();
            files.items.add(new File([midi.toArray()], "tempo-${bpm ?? "none"}.mid", { type: "audio/midi" }));
            input.files = files.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            for (let i = 0; i < 50 && !/tempo-${bpm ?? "none"}/.test(document.getElementById("piece-name").textContent); i++) {
                await new Promise((r) => setTimeout(r, 100));
            }
            const t = window.sheetMusic.timeline;
            return {
                quarterSeconds: Math.round((t.notes[1].time - t.notes[0].time) * 1000) / 1000,
                slider: document.getElementById("tempo-value").textContent,
            };
        `);
        check("a MIDI file with no tempo plays at 120", await midiTempo(null), { quarterSeconds: 0.5, slider: "120 BPM" });
        check("and one at 62.5 says 62.5", await midiTempo(62.5), { quarterSeconds: 0.96, slider: "62.5 BPM" });

        // --- tempo marks, however a score writes them ------------------------
        // MusicXML's <sound tempo> is quarter notes a minute; a printed mark
        // can be in any note value. Each case is timed from the timeline: the
        // quarter-note BPM each bar plays at.
        console.log("\ntempo marks");
        const tempoNote = (type, dur) =>
            `<note><pitch><step>C</step><octave>5</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type></note>`;
        const quarters = (n) => tempoNote("quarter", 480).repeat(n);
        const mark = (unit, perMinute, dots = 0) =>
            `<direction placement="above"><direction-type><metronome><beat-unit>${unit}</beat-unit>` +
            `${"<beat-unit-dot/>".repeat(dots)}<per-minute>${perMinute}</per-minute></metronome></direction-type></direction>`;
        const sound = (bpm) => `<direction><direction-type><words/></direction-type><sound tempo="${bpm}"/></direction>`;
        const tempoScore = (beats, beatType, bars, parts = 1) => {
            const part = (p) => `<part id="P${p}">` + bars.map((content, i) =>
                `<measure number="${i + 1}">` +
                (i === 0 ? `<attributes><divisions>480</divisions><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>` : "") +
                (typeof content === "function" ? content(p) : content) + "</measure>").join("") + "</part>";
            const ids = Array.from({ length: parts }, (_, i) => i + 1);
            return `<?xml version="1.0"?><score-partwise version="3.1"><part-list>${ids.map((p) =>
                `<score-part id="P${p}"><part-name>P${p}</part-name></score-part>`).join("")}</part-list>${ids.map(part).join("")}</score-partwise>`;
        };
        // Quarter-note BPM per bar, from the gap between its first two onsets
        // (in a score of several parts, notes in different parts coincide).
        const playedAt = (xml) => page.evaluate(`
            const t = await window.sheetMusic.score.load(${JSON.stringify(xml)});
            const bars = [...new Set(t.steps.map((s) => s.measure))];
            return {
                bpm: t.bpm,
                bars: bars.map((bar) => {
                    const onsets = [...new Set(t.notes
                        .filter((n) => t.steps[n.step]?.measure === bar).map((n) => n.time))];
                    return Math.round(600 / (onsets[1] - onsets[0])) / 10;
                }),
            };
        `);
        const tempoCases = [
            ["quarter = 120 with <sound>", tempoScore(4, 4, [mark("quarter", 120).replace("</direction>", '<sound tempo="120"/></direction>') + quarters(4), quarters(4)]), [120, 120]],
            ["eighth = 120 is 60 quarters a minute", tempoScore(4, 4, [mark("eighth", 120) + quarters(4), quarters(4)]), [60, 60]],
            ["half = 60 is 120", tempoScore(2, 2, [mark("half", 60) + quarters(4), quarters(4)]), [120, 120]],
            ["dotted quarter = 60 is 90", tempoScore(6, 8, [mark("quarter", 60, 1) + quarters(3), quarters(3)]), [90, 90]],
            ["dotted half = 40 is 120", tempoScore(3, 4, [mark("half", 40, 1) + quarters(3), quarters(3)]), [120, 120]],
            ["<sound> wins over the printed mark", tempoScore(4, 4, [mark("half", 30).replace("</direction>", '<sound tempo="72"/></direction>') + quarters(4), quarters(4)]), [72, 72]],
            ["dotted quarter = 60 copied as <sound> 60 is still 90", tempoScore(6, 8, [mark("quarter", 60, 1).replace("</direction>", '<sound tempo="60"/></direction>') + quarters(3), quarters(3)]), [90, 90]],
            ["a fractional tempo is not rounded", tempoScore(4, 4, [sound(62.5) + quarters(4), quarters(4)]), [62.5, 62.5]],
            ["a change at a barline", tempoScore(4, 4, [sound(60) + quarters(4), sound(120) + quarters(4)]), [60, 120]],
            ["a mark in the second part only", tempoScore(4, 4, [(p) => (p === 2 ? mark("half", 45) : "") + quarters(4), quarters(4)], 2), [90, 90]],
            ["no mark at all", tempoScore(4, 4, [quarters(4), quarters(4)]), [100, 100]],
        ];
        for (const [label, xml, expected] of tempoCases) {
            check(label, (await playedAt(xml)).bars, expected);
        }

        // A change in the middle of a bar: the notes and the clicks both follow.
        const midBar = await page.evaluate(`
            const t = await window.sheetMusic.score.load(${JSON.stringify(
                tempoScore(4, 4, [sound(60) + quarters(2) + sound(120) + quarters(2), quarters(4)]),
            )});
            return {
                onsets: t.notes.slice(0, 5).map((n) => Math.round(n.time * 100) / 100),
                clicks: t.beats.slice(0, 5).map((b) => Math.round(b.time * 100) / 100),
            };
        `);
        check("a change mid-bar moves the notes after it", midBar.onsets, [0, 1, 2, 2.5, 3]);
        check("and the clicks with them", midBar.clicks, [0, 1, 2, 2.5, 3]);

        // A compressed .mxl file, through the file picker: unzipped to text,
        // so its printed half-note mark is read right and Download has it.
        const mxl = await page.evaluate(`
            const bytes = Uint8Array.from(atob(${JSON.stringify(
                readFileSync(join(ROOT, "tools/fixtures/cut-time.mxl")).toString("base64"),
            )}), (c) => c.charCodeAt(0));
            const input = document.getElementById("file");
            const files = new DataTransfer();
            files.items.add(new File([bytes], "cut-time.mxl", { type: "application/vnd.recordare.musicxml" }));
            input.files = files.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            for (let i = 0; i < 50 && !/Compressed/.test(document.getElementById("piece-name").textContent); i++) {
                await new Promise((r) => setTimeout(r, 100));
            }
            const t = window.sheetMusic.timeline;
            const download = document.getElementById("download");
            return {
                title: document.getElementById("piece-name").textContent,
                quarterSeconds: Math.round((t.notes[1].time - t.notes[0].time) * 1000) / 1000,
                slider: document.getElementById("tempo-value").textContent,
                downloadHasIt: download.hidden ? false : /Compressed Cut Time/.test(await (await fetch(download.href)).text()),
            };
        `);
        check("a .mxl file loads", mxl.title, "Compressed Cut Time");
        check("at half = 60, so a quarter lasts half a second", mxl.quarterSeconds, 0.5);
        check("with the slider on 120 BPM", mxl.slider, "120 BPM");
        check("and Download saves it, not the piece before", mxl.downloadHasIt, true);

        // --- repeats, endings, jumps and pickups ------------------------------
        // Each bar is one whole note, so the bars played can be read off the
        // timeline's cursor steps in order.
        console.log("\nform: repeats, endings, jumps, pickups");
        const formBar = (n, after = "", before = "") =>
            `<measure number="${n}">` +
            (n === 1 ? `<attributes><divisions>480</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>` : "") +
            `${before}<note><pitch><step>C</step><octave>5</octave></pitch><duration>1920</duration><voice>1</voice><type>whole</type></note>${after}</measure>`;
        const formScore = (bars) =>
            `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1">${bars.join("")}</part></score-partwise>`;
        const forward = '<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>';
        const backward = '<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>';
        const said = (text, sound) => `<direction placement="above"><direction-type><words>${text}</words></direction-type><sound ${sound}/></direction>`;
        const barsPlayed = (xml) => page.evaluate(`
            const t = await window.sheetMusic.score.load(${JSON.stringify(xml)});
            return t.steps.map((s) => s.measure);
        `);
        check("a repeat plays twice", await barsPlayed(formScore([formBar(1, "", forward), formBar(2, backward), formBar(3)])), [1, 2, 1, 2, 3]);
        check("first and second endings", await barsPlayed(formScore([
            formBar(1, "", forward),
            formBar(2, '<barline location="right"><ending number="1" type="stop"/><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>',
                '<barline location="left"><ending number="1" type="start"/></barline>'),
            formBar(3, '<barline location="right"><ending number="2" type="discontinue"/></barline>',
                '<barline location="left"><ending number="2" type="start"/></barline>'),
        ])), [1, 2, 1, 3]);
        check("D.C. al Fine", await barsPlayed(formScore([
            formBar(1), formBar(2, said("Fine", 'fine="yes"')), formBar(3, said("D.C. al Fine", 'dacapo="yes"')),
        ])), [1, 2, 3, 1, 2]);
        check("D.S. al Coda", await barsPlayed(formScore([
            formBar(1),
            formBar(2, "", '<direction><direction-type><segno/></direction-type><sound segno="s"/></direction>'),
            formBar(3, said("To Coda", 'tocoda="c"')),
            formBar(4, said("D.S. al Coda", 'dalsegno="s"')),
            formBar(5, "", '<direction><direction-type><coda/></direction-type><sound coda="c"/></direction>'),
        ])), [1, 2, 3, 4, 2, 3, 5]);

        // A pickup comes in on its own beat: the count-in only counts the
        // beats of its bar before it - unless that is too few to catch the
        // tempo from, when a full bar goes in front.
        const countIn = (xml) => page.evaluate(`
            const t = await window.sheetMusic.score.load(${JSON.stringify(xml)});
            return t.countIn.map((c) => Math.round(c.time * 100) / 100 + (c.accent ? "!" : ""));
        `);
        const withPickup = (type, duration, dot = false) => formScore([
            `<measure number="0" implicit="yes"><attributes><divisions>480</divisions><time><beats>4</beats>` +
                `<beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>` +
                `<note><pitch><step>G</step><octave>4</octave></pitch><duration>${duration}</duration>` +
                `<voice>1</voice><type>${type}</type>${dot ? "<dot/>" : ""}</note></measure>`,
            formBar(2),
        ]);
        check("no pickup: a full bar of count-in", await countIn(formScore([formBar(1), formBar(2)])),
            ["-2.4!", "-1.8", "-1.2", "-0.6"]);
        check("a one-beat pickup comes in on 4", await countIn(withPickup("quarter", 480)),
            ["-1.8!", "-1.2", "-0.6"]);
        check("a three-beat pickup gets a bar and a beat", await countIn(withPickup("half", 1440, true)),
            ["-3!", "-2.4", "-1.8", "-1.2", "-0.6!"]);
        check("an eighth pickup comes in after beat 4", await countIn(withPickup("eighth", 240)),
            ["-2.1!", "-1.5", "-0.9", "-0.3"]);

        // --- rendering ------------------------------------------------------
        console.log("\nrendering");
        await loadSample(page, "twinkle.musicxml");
        check(
            "the score renders as SVG",
            await page.evaluate("return document.querySelectorAll('#score svg').length > 0"),
            true,
        );
        // A hidden container would make OSMD lay the score out zero pixels
        // wide, which still produces an SVG - so check the geometry too.
        const engraving = await page.evaluate(`
            const svg = document.querySelector("#score svg");
            const box = svg.getBoundingClientRect();
            return { width: box.width, height: box.height };
        `);
        check("laid out at a sensible width", engraving.width > 400, true);
        check("and a sensible height", engraving.height > 100, true);

        // Zooming re-engraves the score, which replaces the SVG the cursor and
        // the note colours live in.
        const zoomed = await page.evaluate(`
            const { score } = window.sheetMusic;
            score.showStep(3);
            score.setZoom(0.6);
            const small = document.querySelector("#score svg").getBoundingClientRect().height;
            score.setZoom(1);
            const back = document.querySelector("#score svg").getBoundingClientRect().height;
            return { small, back, step: score.stepIndex, lit: document.querySelectorAll(".note-lit").length };
        `);
        check("zooming out makes the engraving smaller", zoomed.small < zoomed.back, true);
        check("the cursor keeps its place across a re-render", zoomed.step, 3);
        check("and the notes are still lit", zoomed.lit > 0, true);
        check(
            "notes light up under the cursor",
            await page.evaluate(`
                window.sheetMusic.score.showStep(2);
                return document.querySelectorAll('.note-lit').length > 0;
            `),
            true,
        );

        // --- the highlighted notes are the sounding notes -------------------
        // The weaker check above only proves *something* lights up. This walks
        // every cursor step and compares the notes under the cursor with the
        // notes the player starts at that step - the check that would have
        // caught the highlight running one note ahead of the audio.
        console.log("\nhighlight follows the sound");
        for (const sample of ["twinkle.musicxml", "timing-test.musicxml", "drum-groove.musicxml"]) {
            await loadSample(page, sample);
            const result = await page.evaluate(`
                const s = window.sheetMusic.score;
                const tl = window.sheetMusic.timeline;
                const off = opensheetmusicdisplay.Pitch.OctaveXmlDifference;
                const midiOf = (n) =>
                    (n.Pitch.Octave + off + 1) * 12 + n.Pitch.FundamentalNote + n.Pitch.AccidentalHalfTones;
                // A tied continuation sits under the cursor but does not sound
                // again, so it is not expected among the notes that start here.
                const starts = (n) => !n.isRest() && !(n.NoteTie && n.NoteTie.StartNote !== n);

                let wrong = 0;
                let first = null;
                for (let k = 0; k < tl.steps.length; k++) {
                    s.showStep(k);
                    const lit = s.osmd.cursor.NotesUnderCursor().filter(starts).map(midiOf).sort((a, b) => a - b);
                    const sounding = tl.notes.filter((n) => n.step === k).map((n) => n.midi).sort((a, b) => a - b);
                    if (JSON.stringify(lit) !== JSON.stringify(sounding)) {
                        wrong += 1;
                        first ??= "step " + k + ": sounds " + sounding + ", lit " + lit;
                    }
                }
                s.reset();
                return { steps: tl.steps.length, wrong, first };
            `);
            check(
                `${sample}: all ${result.steps} steps light the notes being played`,
                result.wrong,
                0,
            );
            if (result.first) console.log(`       first mismatch - ${result.first}`);
        }

        // --- transposition and drum naming (pure functions) -----------------
        console.log("\ntransposing instruments");
        const transposed = await page.evaluate(`
            const { concertPitch } = await import("./js/instruments.js");
            const written = 72; // C5 as printed
            return {
                piano: concertPitch(written, "piano"),
                clarinet: concertPitch(written, "clarinet"),
                trumpet: concertPitch(written, "trumpet"),
                alto: concertPitch(written, "alto sax"),
                tenor: concertPitch(written, "tenor sax"),
                guitar: concertPitch(written, "guitar"),
                bass: concertPitch(written, "bass"),
                doubleBass: concertPitch(written, "double bass"),
                midiFile: concertPitch(written, "clarinet", false),
            };
        `);
        check("piano plays as written", transposed.piano, 72);
        check("clarinet sounds a tone lower", transposed.clarinet, 70);
        check("trumpet sounds a tone lower", transposed.trumpet, 70);
        check("alto sax sounds a major sixth lower", transposed.alto, 63);
        check("tenor sax sounds a ninth lower", transposed.tenor, 58);
        check("guitar sounds an octave lower", transposed.guitar, 60);
        check("bass sounds an octave lower", transposed.bass, 60);
        check("double bass sounds an octave lower", transposed.doubleBass, 60);
        check("a MIDI file is never transposed", transposed.midiFile, 72);

        // A part whose MusicXML says how it transposes plays at that, whatever
        // is picked: a clarinet part on the piano sound, a horn part a fifth down.
        const declared = await page.evaluate(`
            const { concertPitch } = await import("./js/instruments.js");
            const part = (transpose) => '<?xml version="1.0"?><score-partwise version="3.1"><part-list>' +
                '<score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1"><measure number="1">' +
                '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time>' +
                '<clef><sign>G</sign><line>2</line></clef>' + transpose + '</attributes>' +
                '<note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>' +
                '</measure></part></score-partwise>';
            // Through the file picker once, for what the page says about it.
            const input = document.getElementById("file");
            const files = new DataTransfer();
            files.items.add(new File([part("<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>")],
                "clarinet-part.musicxml", { type: "application/xml" }));
            input.files = files.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            for (let i = 0; i < 50 && !/clarinet-part/.test(document.getElementById("piece-name").textContent); i++) {
                await new Promise((r) => setTimeout(r, 100));
            }
            const said = document.getElementById("status").textContent;
            const clarinetPart = await window.sheetMusic.score.load(
                part("<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>"));
            const hornPart = await window.sheetMusic.score.load(
                part("<transpose><diatonic>-4</diatonic><chromatic>-7</chromatic></transpose>"));
            const plain = await window.sheetMusic.score.load(part(""));
            const sound = (t, key) => concertPitch(t.notes[0].midi, key, true, t.notes[0].transpose);
            return {
                clarinetOnPiano: sound(clarinetPart, "piano"),
                clarinetOnClarinet: sound(clarinetPart, "clarinet"),
                hornOnPiano: sound(hornPart, "piano"),
                plainOnClarinet: sound(plain, "clarinet"),
                transposedBy: [clarinetPart.transposedBy, hornPart.transposedBy, plain.transposedBy],
                said,
            };
        `);
        check("a clarinet part sounds a tone down, even on the piano sound", declared.clarinetOnPiano, 60);
        check("and not twice over on the clarinet sound", declared.clarinetOnClarinet, 60);
        check("a horn part sounds a fifth down", declared.hornOnPiano, 55);
        check("a part that says nothing follows the picker", declared.plainOnClarinet, 60);
        check("the timeline knows what the score says", declared.transposedBy, [-2, -7, null]);
        check("and the page says so", /sounds 2 semitones lower than written/.test(declared.said), true);

        console.log("\ndrum mapping");
        const kit = await page.evaluate(`
            const { resolveDrumName, gmKeyFromStaffPosition } = await import("./js/drums.js");
            const names = window.sheetMusic.player.drumNames.length
                ? window.sheetMusic.player.drumNames
                : ["kick", "snare", "hihat-close", "hihat-open", "cymbal", "tom-low", "clap"];
            return {
                kick: resolveDrumName(36, names),
                snare: resolveDrumName(38, names),
                closedHat: resolveDrumName(42, names),
                openHat: resolveDrumName(46, names),
                crash: resolveDrumName(49, names),
                unknown: resolveDrumName(99, names),
                staffKick: gmKeyFromStaffPosition(65), // F4
                staffSnare: gmKeyFromStaffPosition(72), // C5
                staffHat: gmKeyFromStaffPosition(79), // G5
            };
        `);
        check("kick", kit.kick, "kick");
        check("snare", kit.snare, "snare");
        check("closed hi-hat", kit.closedHat, "hihat-close");
        check("open hi-hat", kit.openHat, "hihat-open");
        check("crash falls back to a cymbal", kit.crash, "cymbal");
        check("an unmapped key still makes a sound", kit.unknown, "snare");
        check("F4 on a drum staff is the kick", kit.staffKick, 36);
        check("C5 is the snare", kit.staffSnare, 38);
        check("G5 above the staff is the hi-hat", kit.staffHat, 42);

        // --- served by the app, so reading a photo is on offer ---------------
        console.log("\nserved with a reader behind it");
        const health = await page.evaluate(`
            const response = await fetch("api/health");
            const body = await response.json();
            return {
                ok: response.ok,
                canRead: body.canRead,
                noticeHidden: document.getElementById("no-reader").hidden,
                noticeText: document.getElementById("no-reader").textContent,
                acceptsImages: document.getElementById("file").accept.includes("image/*"),
            };
        `);
        check("the health endpoint answers", health.ok, true);
        // The suite runs the server without a key, so what matters is that the
        // interface agrees with what the server reports either way.
        check("the notice matches whether it can read", health.noticeHidden, health.canRead);
        check("the picker matches too", health.acceptsImages, health.canRead);
        check(
            "and it explains which case it is",
            health.canRead || /API key is set/.test(health.noticeText),
            true,
        );

        // --- writing a score by hand ----------------------------------------
        console.log("\nwriting a score");
        const written = await page.evaluate(`
            document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 200));

            const key = (name) =>
                [...document.querySelectorAll(".key")]
                    .find((k) => k.getAttribute("aria-label") === name);
            const lengths = [...document.querySelectorAll(".length")];

            // A quarter C, a quarter E, then a half G.
            key("C4").click();
            key("E4").click();
            lengths[1].click();          // half note
            key("G4").click();
            await new Promise((r) => setTimeout(r, 400));

            const timeline = window.sheetMusic.timeline;
            const xml = window.sheetMusic.editor.toMusicXml();
            return {
                open: !document.getElementById("editor").hidden,
                midis: timeline.notes.map((n) => n.midi),
                durations: timeline.notes.map((n) => Math.round(n.duration * 100) / 100),
                xmlIsScore: xml.includes("<score-partwise"),
                measures: timeline.measureCount,
            };
        `);
        check("the writer opens", written.open, true);
        check("the notes tapped are the notes written", written.midis, [60, 64, 67]);
        // 100 BPM: a quarter is 0.6s and a half is 1.2s.
        check("with the lengths chosen", written.durations, [0.6, 0.6, 1.2]);
        check("it produces a score", written.xmlIsScore, true);

        const edited = await page.evaluate(`
            const editor = window.sheetMusic.editor;
            editor.undo();
            await new Promise((r) => setTimeout(r, 300));
            const afterUndo = window.sheetMusic.timeline.notes.length;

            editor.addRest();
            await new Promise((r) => setTimeout(r, 300));
            const withRest = window.sheetMusic.timeline.notes.length;

            editor.clear();
            await new Promise((r) => setTimeout(r, 300));
            const afterClear = window.sheetMusic.timeline.notes.length;

            document.querySelector(".editor-head .primary").click();
            return {
                afterUndo,
                withRest,
                afterClear,
                closed: document.getElementById("editor").hidden,
                canReopen: !document.getElementById("edit-score").hidden,
            };
        `);
        check("undo removes the last note", edited.afterUndo, 2);
        check("a rest adds no sounding note", edited.withRest, 2);
        check("clear empties it", edited.afterClear, 0);
        check("Done closes the writer", edited.closed, true);
        check("and it can be reopened", edited.canReopen, true);

        // --- the seek bar ----------------------------------------------------
        console.log("\nthe seek bar");
        await page.send("Emulation.setDeviceMetricsOverride", {
            width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
        });
        await loadSample(page, "timing-test.musicxml");
        const seekBar = await page.evaluate(`
            const { player, timeline, score } = window.sheetMusic;
            const seek = document.getElementById("seek");
            const label = (id) => document.getElementById(id).textContent;
            const slide = async (to) => {
                seek.value = String(to);
                seek.dispatchEvent(new Event("input"));
                await new Promise((r) => setTimeout(r, 900));
            };
            const out = { max: Number(seek.max), duration: timeline.duration, total: label("time-total") };
            await slide(12);
            out.after = { state: player.state, at: player.position(), now: label("time-now"),
                step: score.stepIndex, expected: player.stepAt(12), bar: label("position") };
            // Slowing the tempo makes the piece longer, and the clock says so.
            const tempo = document.getElementById("tempo");
            tempo.value = "48";
            tempo.dispatchEvent(new Event("input"));
            out.slower = label("time-total");
            document.getElementById("tempo-reset").click();
            // To the end: the highlighted note scrolls into view, clear of the bar.
            await slide(timeline.duration - 0.5);
            const lit = document.querySelector(".note-lit").getBoundingClientRect();
            const bar = document.getElementById("controls").getBoundingClientRect();
            out.endInView = lit.top >= 0 && lit.bottom <= bar.top;
            player.stop();
            out.afterStop = [label("time-now"), Number(seek.value)];
            return out;
        `);
        check("the bar spans the whole piece", seekBar.max, seekBar.duration);
        check("and says how long it is", seekBar.total, "0:24");
        check("sliding it moves there, paused", [seekBar.after.state, seekBar.after.at, seekBar.after.now], ["paused", 12, "0:12"]);
        check("with the notes there highlighted", seekBar.after.step, seekBar.after.expected);
        check("on the second time through the repeat", seekBar.after.bar, "bar 1");
        check("half the tempo, twice the length", seekBar.slower, "0:48");
        check("near the end, the highlight scrolls into view", seekBar.endInView, true);
        check("Stop goes back to the start", seekBar.afterStop, ["0:00", 0]);

        await loadSample(page, "groove.mid");
        const rollSeek = await page.evaluate(`
            const seek = document.getElementById("seek");
            seek.value = String(Number(seek.max) / 2);
            seek.dispatchEvent(new Event("input"));
            await new Promise((r) => setTimeout(r, 300));
            const x = Number(document.querySelector(".roll-playhead").getAttribute("x1"));
            window.sheetMusic.player.stop();
            return x;
        `);
        // Halfway along a 1000-wide roll, give or take the slider's 0.01s steps.
        check("on a piano roll, the playhead goes there too", Math.abs(rollSeek - 500) < 3, true);
        await page.send("Emulation.clearDeviceMetricsOverride");

        // --- asking when the music looks written for another instrument ------
        console.log("\nasking about the instrument");
        const question = await page.evaluate(`
            const select = document.getElementById("instrument");
            const card = document.getElementById("instrument-check");
            const pick = (value) => { select.value = value; select.dispatchEvent(new Event("change")); };
            const state = () => ({
                shown: !card.hidden,
                text: card.hidden ? null : document.getElementById("instrument-check-text").textContent,
                picked: select.value,
            });
            const out = {};

            pick("flute");
            await window.sheetMusic.loadSample("drum-groove.musicxml");
            out.drums = state();
            document.getElementById("instrument-switch").click();
            await new Promise((r) => setTimeout(r, 200));
            out.switched = state();

            pick("flute");
            await window.sheetMusic.loadSample("twinkle.musicxml");
            out.twinkle = state();
            document.getElementById("instrument-keep").click();
            out.kept = state();

            pick("piano");
            await window.sheetMusic.loadSample("twinkle.musicxml");
            out.matching = state();
            await window.sheetMusic.loadSample("groove.mid");
            out.mixedMidi = state();

            // What you write yourself is never second-guessed.
            pick("flute");
            document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 400));
            document.querySelector(".key").click();
            await new Promise((r) => setTimeout(r, 600));
            out.written = state();
            window.sheetMusic.editor.clear();
            document.querySelector(".editor-head .primary").click();
            pick("piano");
            return out;
        `);
        check("drum music with Flute picked asks", question.drums,
            { shown: true, text: "This looks like drum music, but Flute is picked.", picked: "flute" });
        check("and Play it as Drums switches", question.switched, { shown: false, text: null, picked: "drums" });
        check("a piano score with Flute picked asks too", question.twinkle,
            { shown: true, text: "This looks written for Piano, but Flute is picked.", picked: "flute" });
        check("and Keep keeps the pick", question.kept, { shown: false, text: null, picked: "flute" });
        check("no question when the pick matches", question.matching.shown, false);
        check("nor for a MIDI file with a piano and a drum kit", question.mixedMidi.shown, false);
        check("nor for a score you write yourself", question.written.shown, false);

        // --- tapping a note goes there --------------------------------------
        console.log("\ntapping a note to go there");
        await page.send("Emulation.setDeviceMetricsOverride", {
            width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
        });
        await loadSample(page, "timing-test.musicxml");
        // Real mouse events at a drawn note: the first note of bar 2.
        const tapNoteAt = async (whole) => {
            const point = await page.evaluate(`
                // Moving the position can start a smooth scroll to show it:
                // let the page come to rest before measuring where to tap.
                let last = -1;
                for (let i = 0; i < 40 && scrollY !== last; i++) {
                    last = scrollY;
                    await new Promise((r) => setTimeout(r, 100));
                }
                document.getElementById("score").scrollIntoView({ block: "start", behavior: "instant" });
                await new Promise((r) => setTimeout(r, 200));
                const sheet = window.sheetMusic.score.osmd.GraphicSheet;
                for (const staves of sheet.MeasureList) for (const measure of staves)
                    for (const entry of measure.staffEntries) for (const voice of entry.graphicalVoiceEntries)
                        for (const note of voice.notes) {
                            if (Math.abs(note.sourceNote.getAbsoluteTimestamp().RealValue - ${whole}) > 1e-6) continue;
                            const box = note.getSVGGElement().getBoundingClientRect();
                            const x = box.left + box.width / 2, y = box.top + box.height / 2;
                            // Only tap what is really the score at that point.
                            if (!document.getElementById("score").contains(document.elementFromPoint(x, y))) {
                                throw new Error("the note at " + ${whole} + " is covered, not tappable");
                            }
                            return { x, y };
                        }
                return null;
            `);
            for (const type of ["mousePressed", "mouseReleased"]) {
                await page.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
            }
            await new Promise((r) => setTimeout(r, 400));
            return page.evaluate(`
                const { player, score, timeline } = window.sheetMusic;
                return {
                    state: player.state,
                    at: Math.round(player.position() * 100) / 100,
                    step: score.stepIndex,
                    bar: document.getElementById("position").textContent,
                    now: document.getElementById("time-now").textContent,
                };
            `);
        };
        // Bar 2 starts a whole note in; at 96 BPM a bar is 2.5 seconds.
        const tapped = await tapNoteAt(1);
        check("tapping a note goes there, paused", [tapped.state, tapped.at, tapped.bar, tapped.now],
            ["paused", 2.5, "bar 2", "0:03"]);
        // Bars 1-4 repeat. From the second time through, the same note means
        // that pass, not the first.
        await page.evaluate(`window.sheetMusic.player.seek(12)`);
        const second = await tapNoteAt(1);
        check("in a repeat, the pass nearest where you are", second.at, 12.5);
        await page.evaluate(`window.sheetMusic.player.stop()`);
        await page.send("Emulation.clearDeviceMetricsOverride");

        // --- on a phone the play bar never hides the page under it -----------
        // The bar is docked to the bottom and grows when More is open, so the
        // room left for it, and where scrolling stops, follow its real height.
        console.log("\nthe play bar on a phone");
        await page.send("Emulation.setDeviceMetricsOverride", {
            width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
        });
        await loadSample(page, "timing-test.musicxml");
        const bar = await page.evaluate(`
            document.querySelector(".editor-head .primary")?.click();
            const more = document.querySelector(".more");
            if (more.getAttribute("aria-expanded") !== "true") more.click();
            await new Promise((r) => setTimeout(r, 400));
            window.scrollTo(0, document.documentElement.scrollHeight);
            await new Promise((r) => setTimeout(r, 300));
            const controls = document.getElementById("controls").getBoundingClientRect();
            const out = {
                barHeight: Math.round(controls.height),
                scoreClear: document.getElementById("score").getBoundingClientRect().bottom <= controls.top,
                paddingCovers: parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) >= controls.height,
            };
            more.click();
            window.scrollTo(0, 0);
            return out;
        `);
        await page.send("Emulation.clearDeviceMetricsOverride");
        check("with More open the bar is taller than its closed 76px", bar.barHeight > 76, true);
        check("and the end of the score still scrolls clear of it", bar.scoreClear, true);
        check("and scrolling into view stops above it", bar.paddingCovers, true);

        // --- on a phone the writer docks, and you can see what you write -----
        console.log("\nwriting on a phone");
        await page.evaluate(`document.querySelector(".editor-head .primary")?.click();`);
        await page.send("Emulation.setDeviceMetricsOverride", {
            width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
        });
        const phone = await page.evaluate(`
            document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 300));
            window.sheetMusic.editor.clear();
            document.querySelectorAll(".length")[2].click();
            const key = (n) => [...document.querySelectorAll(".key")]
                .find((k) => k.getAttribute("aria-label") === n);
            for (const n of ["C4","D4","E4","F4","G4","A4","B4","A4","G4","F4","E4","D4","C4","E4","G4","E4"]) {
                key(n).click();
                await new Promise((r) => setTimeout(r, 60));
            }
            await new Promise((r) => setTimeout(r, 1200));

            const sheet = document.getElementById("editor").getBoundingClientRect();
            const score = document.querySelector("#score svg").getBoundingClientRect();
            const settings = document.querySelector(".editor-more");
            const writing = {
                docked: getComputedStyle(document.getElementById("editor")).position,
                newestInView: score.bottom <= sheet.top + 4 && score.bottom > 0,
                transportHidden: getComputedStyle(document.getElementById("controls")).display === "none",
                settingsFolded: !settings.open,
                summary: settings.querySelector("summary").textContent,
            };
            // Selecting a note brings the most buttons: they should still be
            // one row, or they push the keyboard down the screen.
            const rows = () => new Set([...document.querySelectorAll(".editor-actions button")]
                .map((b) => Math.round(b.getBoundingClientRect().top))).size;
            window.sheetMusic.editor.select(2);
            writing.editingRows = rows();
            window.sheetMusic.editor.select(2);
            document.querySelector(".editor-head .primary").click();
            await new Promise((r) => setTimeout(r, 150));
            writing.transportBackAfterDone =
                getComputedStyle(document.getElementById("controls")).display !== "none";
            window.sheetMusic.editor.clear();
            return writing;
        `);
        await page.send("Emulation.clearDeviceMetricsOverride");
        check("the writer docks to the bottom", phone.docked, "fixed");
        check("and the newest notes stay in view above it", phone.newestInView, true);
        check("the transport bar steps aside while writing", phone.transportHidden, true);
        check("and comes back after Done", phone.transportBackAfterDone, true);
        check("editing a note keeps the buttons on one row", phone.editingRows, 1);
        check("settings start folded on a phone", phone.settingsFolded, true);
        check("behind a summary of what they are", phone.summary, "4/4 · ♩ 100 · C major · treble");
        await page.evaluate(`document.getElementById("write-music").click();`);
        await new Promise((r) => setTimeout(r, 300));

        // --- on a laptop the writer is a panel beside the score ---------------
        console.log("\nwriting on a laptop");
        await page.send("Emulation.setDeviceMetricsOverride", {
            width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
        });
        const laptop = await page.evaluate(`
            document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 300));
            const editor = window.sheetMusic.editor;
            editor.stacking = false;
            editor.clear();
            const key = (n) => [...document.querySelectorAll(".key")]
                .find((k) => k.getAttribute("aria-label") === n);
            for (const n of ["C4", "E4", "G4", "E4"]) { key(n).click(); await new Promise((r) => setTimeout(r, 60)); }
            await new Promise((r) => setTimeout(r, 800));

            const panel = document.getElementById("editor").getBoundingClientRect();
            const score = document.querySelector("#score svg").getBoundingClientRect();
            const keyboard = document.querySelector(".keyboard").getBoundingClientRect();
            const out = {
                placement: getComputedStyle(document.getElementById("editor")).position,
                panelBesideScore: panel.left >= score.right - 1,
                scoreInView: score.top < innerHeight && score.bottom > 0,
                panelFitsWindow: panel.bottom <= innerHeight + 1,
                keyboardWidth: Math.round(keyboard.width),
            };
            editor.clear();
            document.querySelector(".editor-head .primary").click();
            return out;
        `);
        await page.send("Emulation.clearDeviceMetricsOverride");
        check("the writer is a panel that stays put", laptop.placement, "sticky");
        check("beside the score, not above it", laptop.panelBesideScore, true);
        check("so the score being written is in view", laptop.scoreInView, true);
        check("and the whole panel fits the window", laptop.panelFitsWindow, true);
        check("with a keyboard of sensible width", laptop.keyboardWidth <= 420, true);
        await page.evaluate(`document.getElementById("write-music").click();`);
        await new Promise((r) => setTimeout(r, 300));

        // --- the key pressed is the note written -----------------------------
        console.log("\nspelling and key signatures");
        const spelling = await page.evaluate(`
            const editor = window.sheetMusic.editor;
            const blackKeys = () => [...document.querySelectorAll(".key.black")];
            const labels = () => blackKeys().map((k) => k.textContent);
            const written = () => [...editor.toMusicXml().matchAll(
                /<step>(\\w)<\\/step>\\s*(?:<alter>(-?\\d)<\\/alter>)?/g,
            )].map((m) => m[1] + (m[2] === "1" ? "#" : m[2] === "-1" ? "b" : ""));
            const setKey = async (fifths) => {
                const select = document.querySelector('[aria-label="Key signature"]');
                select.value = String(fifths);
                select.dispatchEvent(new Event("change"));
                await new Promise((r) => setTimeout(r, 150));
            };
            const tapAllBlack = () => blackKeys().forEach((k) => k.click());
            const stack = [...document.querySelectorAll(".editor-actions button")]
                .find((b) => b.textContent === "Chord");

            const out = { stackStartsOff: !stack.classList.contains("chosen") };
            await setKey(0); editor.clear(); tapAllBlack();
            out.c = { labels: labels(), written: written() };
            await setKey(-1); editor.clear(); tapAllBlack();
            out.f = { labels: labels(), written: written(), fifths: /<fifths>-1</.test(editor.toMusicXml()) };
            await setKey(2); editor.clear(); tapAllBlack();
            out.d = { labels: labels(), written: written(), fifths: /<fifths>2</.test(editor.toMusicXml()) };
            await setKey(0); editor.clear();
            return out;
        `);
        check("Chord starts switched off, and looks it", spelling.stackStartsOff, true);
        check("C major: the keys read C# Eb F# Ab Bb", spelling.c.labels, ["C♯", "E♭", "F♯", "A♭", "B♭"]);
        check("and that is what gets written", spelling.c.written, ["C#", "Eb", "F#", "Ab", "Bb"]);
        check("F major spells them as flats", spelling.f.written, ["Db", "Eb", "Gb", "Ab", "Bb"]);
        check("with the labels to match", spelling.f.labels, ["D♭", "E♭", "G♭", "A♭", "B♭"]);
        check("and one flat in the key signature", spelling.f.fifths, true);
        check("D major spells them as sharps", spelling.d.written, ["C#", "D#", "F#", "G#", "A#"]);
        check("with two sharps in the key signature", spelling.d.fifths, true);

        // --- fixing a note in the middle -------------------------------------
        console.log("\nediting any note");
        const edits = await page.evaluate(`
            const editor = window.sheetMusic.editor;
            editor.clear();
            if (editor.selected !== null) editor.select(editor.selected);
            document.querySelectorAll(".length")[2].click();
            const key = (n) => [...document.querySelectorAll(".key")]
                .find((k) => k.getAttribute("aria-label") === n);
            const chips = () => [...document.querySelectorAll(".chip")];
            const action = (t) => [...document.querySelectorAll(".editor-actions button")]
                .find((b) => b.textContent === t);
            const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));

            for (const n of ["C4", "D4", "E4", "F4", "G4"]) { key(n).click(); await wait(40); }
            await wait(400);
            const written = chips().map((c) => c.textContent);

            chips()[1].click(); await wait(300);
            const litStep = window.sheetMusic.score.stepIndex;
            key("A4").click(); await wait(400);                         // D -> A
            chips()[2].click(); await wait();
            document.querySelectorAll(".length")[1].click(); await wait(400); // E -> half
            chips()[3].click(); await wait();
            action("Delete").click(); await wait(400);                  // drop the F
            action("Done editing").click(); await wait();
            key("B4").click(); await wait(500);                         // add at the end
            editor.undo(); await wait(400);                             // undo still works

            const timeline = window.sheetMusic.timeline;
            const out = {
                written,
                after: chips().map((c) => c.textContent),
                litStep,
                midis: timeline.notes.map((n) => n.midi),
                durations: timeline.notes.map((n) => Math.round(n.duration * 100) / 100),
            };
            editor.clear();
            return out;
        `);
        check("the strip lists what was written", edits.written, ["C4", "D4", "E4", "F4", "G4"]);
        check("selecting a note lights it on the score", edits.litStep, 1);
        check("a key replaces the selected pitch, Delete removes one", edits.after, ["C4", "A4", "E4", "G4"]);
        check("so the score holds the edited notes", edits.midis, [60, 69, 64, 67]);
        check("with the new length on the third", edits.durations, [0.6, 0.6, 1.2, 0.6]);

        // --- triplets ---------------------------------------------------------
        console.log("\ntriplets");
        const triplets = await page.evaluate(`
            const editor = window.sheetMusic.editor;
            if (editor.selected !== null) editor.select(editor.selected);
            editor.stacking = false;
            editor.clear();
            const key = (n) => [...document.querySelectorAll(".key")]
                .find((k) => k.getAttribute("aria-label") === n);
            const length = (name) => [...document.querySelectorAll(".length")]
                .find((b) => b.getAttribute("aria-label") === name);

            length("eighth note").click();
            length("Triplet").click();
            for (const n of ["C4", "D4", "E4"]) { key(n).click(); await new Promise((r) => setTimeout(r, 60)); }
            length("Triplet").click();
            length("quarter note").click();
            key("F4").click();
            length("half note").click();
            key("G4").click();
            await new Promise((r) => setTimeout(r, 600));

            const t = window.sheetMusic.timeline;
            const xml = editor.toMusicXml();
            const round = (n) => Math.round(n * 1000) / 1000;
            const out = {
                chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent),
                onsets: t.notes.map((n) => round(n.time)),
                durations: t.notes.map((n) => round(n.duration)),
                timeModifications: xml.split("<time-modification>").length - 1,
                brackets: xml.split('tuplet type="start"').length - 1,
                // eighths are beamed by the beat rather than flagged one by one
                beams: document.querySelectorAll("#score .vf-beam").length,
                // OSMD read them as tuplets, which is what draws the 3 over them
                osmdTuplets: window.sheetMusic.score.osmd.Sheet.SourceMeasures[0]
                    .VerticalSourceStaffEntryContainers.flatMap((c) => c.StaffEntries)
                    .flatMap((e) => e?.VoiceEntries ?? []).flatMap((v) => v.Notes)
                    .filter((n) => n.NoteTuplet).length,
            };
            editor.clear();
            return out;
        `);
        check("triplets are marked in the strip", triplets.chips, ["C4³", "D4³", "E4³", "F4", "G4"]);
        // 100 BPM: a triplet eighth is a third of a beat, 0.2s.
        check("three triplet eighths fill one beat", triplets.onsets, [0, 0.2, 0.4, 0.6, 1.2]);
        check("each lasting a third of it", triplets.durations, [0.2, 0.2, 0.2, 0.6, 1.2]);
        check("written as three in the time of two", triplets.timeModifications, 3);
        check("under one bracket", triplets.brackets, 1);
        check("and read back as a tuplet", triplets.osmdTuplets, 3);
        check("beamed together, not flagged one by one", triplets.beams >= 1, true);

        // --- stacking notes into chords --------------------------------------
        console.log("\nchords");
        const chords = await page.evaluate(`
            window.sheetMusic.editor.clear();
            // Pick the length explicitly: an earlier section leaves a half
            // note selected, and this check is about onsets.
            document.querySelectorAll(".length")[2].click();
            const key = (n) => [...document.querySelectorAll(".key")]
                .find((k) => k.getAttribute("aria-label") === n);
            const action = (t) => [...document.querySelectorAll(".editor-actions button")]
                .find((b) => b.textContent === t);

            const mode = () => document.querySelector(".editor-mode").textContent;
            const said = { before: mode(), nextBefore: Boolean(action("Next chord")) };
            action("Chord").click();
            said.on = mode();
            said.nextOn = Boolean(action("Next chord"));
            key("C4").click();
            key("E4").click();
            said.building = mode();
            said.nextBuilding = Boolean(action("Next chord"));
            key("G4").click();
            action("Chord").click();
            said.off = mode();
            key("D4").click();
            await new Promise((r) => setTimeout(r, 500));

            const timeline = window.sheetMusic.timeline;
            const xml = window.sheetMusic.editor.toMusicXml();
            return {
                said,
                written: window.sheetMusic.editor.score.notes.length,
                midis: timeline.notes.map((n) => n.midi),
                onsets: timeline.notes.map((n) => Math.round(n.time * 100) / 100),
                chordTags: xml.split("<chord" + "/>").length - 1,
            };
        `);
        check("three taps make one chord, not three notes", chords.written, 2);
        check("all of its pitches are there", chords.midis, [60, 64, 67, 62]);
        check("and they sound together", chords.onsets, [0, 0, 0, 0.6]);
        check("written as a chord", chords.chordTags, 2);
        check("the writer says how to write a chord", chords.said.before,
            "Tap a key to add a quarter note. For notes that sound together, press Chord.");
        check("and what chord mode does once it is on", chords.said.on, "Chord: tap the notes that sound together.");
        check("and which chord is being built", chords.said.building,
            "Chord C4·E4: tap to add more. Next chord starts another.");
        check("and when it is off again", chords.said.off, chords.said.before);
        const eighths = await page.evaluate(`
            const length = (name) => [...document.querySelectorAll(".length")]
                .find((b) => b.getAttribute("aria-label") === name);
            length("eighth note").click();
            const plain = document.querySelector(".editor-mode").textContent;
            length("Triplet").click();
            const triplet = document.querySelector(".editor-mode").textContent;
            length("Triplet").click();
            length("quarter note").click();
            return [plain, triplet].map((s) => s.split(".")[0]);
        `);
        check("it is an eighth, not a eighth", eighths, ["Tap a key to add an eighth note", "Tap a key to add an eighth-note triplet"]);
        check("Next chord appears only once a chord has a note",
            [chords.said.nextBefore, chords.said.nextOn, chords.said.nextBuilding], [false, false, true]);

        // A progression: Next chord ends one chord and starts the next, so
        // writing C then F then G needs no switching chord mode off and on.
        const progression = await page.evaluate(`
            const editor = window.sheetMusic.editor;
            editor.stacking = false;
            editor.clear();
            const key = (n) => [...document.querySelectorAll(".key")]
                .find((k) => k.getAttribute("aria-label") === n);
            const action = (t) => [...document.querySelectorAll(".editor-actions button")]
                .find((b) => b.textContent === t);

            action("Chord").click();
            for (const n of ["C4", "E4", "G4"]) key(n).click();
            action("Next chord").click();
            // The keyboard shows one octave, so F and G come as inversions.
            for (const n of ["C4", "F4", "A4"]) key(n).click();
            action("Next chord").click();
            for (const n of ["D4", "G4", "B4"]) key(n).click();
            const out = {
                chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent),
                stillChord: editor.stacking,
            };
            editor.stacking = false;
            editor.clear();
            return out;
        `);
        check("Next chord writes a progression", progression.chips, ["C4·E4·G4", "C4·F4·A4", "D4·G4·B4"]);
        check("and stays in chord mode", progression.stillChord, true);

        // The case that went wrong on the live site: a chord written after
        // other notes must be a new chord, not merged into the note before it.
        const afterNotes = await page.evaluate(`
            const editor = window.sheetMusic.editor;
            editor.stacking = false;
            editor.clear();
            const key = (n) => [...document.querySelectorAll(".key")]
                .find((k) => k.getAttribute("aria-label") === n);
            const length = (name) => [...document.querySelectorAll(".length")]
                .find((b) => b.getAttribute("aria-label") === name);
            const action = (t) => [...document.querySelectorAll(".editor-actions button")]
                .find((b) => b.textContent === t);

            length("eighth note").click();
            length("Triplet").click();
            for (const n of ["C4", "E4", "G4"]) key(n).click();
            length("Triplet").click();
            length("half note").click();
            action("Chord").click();
            for (const n of ["C4", "E4", "G4"]) key(n).click();
            action("Chord").click();
            await new Promise((r) => setTimeout(r, 500));
            const out = {
                chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent),
                durations: window.sheetMusic.timeline.notes.map((n) => Math.round(n.duration * 100) / 100),
            };
            editor.clear();
            return out;
        `);
        check("a chord after other notes is a new note", afterNotes.chips, ["C4³", "E4³", "G4³", "C4·E4·G4"]);
        check("at the length chosen for it", afterNotes.durations, [0.2, 0.2, 0.2, 1.2, 1.2, 1.2]);

        // --- writing drums ---------------------------------------------------
        console.log("\nwriting drums");
        const kitWriting = await page.evaluate(`
            document.getElementById("instrument").value = "drums";
            document.getElementById("instrument").dispatchEvent(new Event("change"));
            document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 300));

            const pad = (name) =>
                [...document.querySelectorAll(".pad")].find((p) => p.textContent === name);
            pad("Kick").click();
            pad("Hi-hat").click();
            pad("Snare").click();
            pad("Crash").click();
            await new Promise((r) => setTimeout(r, 500));

            const timeline = window.sheetMusic.timeline;
            const xml = window.sheetMusic.editor.toMusicXml();
            return {
                pads: document.querySelectorAll(".pad").length,
                keys: document.querySelectorAll(".key").length,
                drumKeys: timeline.notes.map((n) => n.drumKey),
                everyNoteIsADrum: timeline.notes.every((n) => n.drumKey !== null),
                percussionClef: xml.includes("<sign>percussion</sign>"),
                unpitched: xml.includes("<unpitched>"),
                channelTen: xml.includes("<midi-channel>10</midi-channel>"),
                crossNotehead: xml.includes("<notehead>x</notehead>"),
            };
        `);
        check("the kit replaces the keyboard", [kitWriting.pads, kitWriting.keys], [9, 0]);
        // Kick 36, closed hi-hat 42, snare 38, crash 49.
        check("the pads tapped are the drums written", kitWriting.drumKeys, [36, 42, 38, 49]);
        check("and they all play as drums", kitWriting.everyNoteIsADrum, true);
        check("on a percussion clef", kitWriting.percussionClef, true);
        check("as unpitched notes", kitWriting.unpitched, true);
        check("mapped to channel 10", kitWriting.channelTen, true);
        check("with cross noteheads for cymbals", kitWriting.crossNotehead, true);

        // A kick and a hi-hat on the same beat is the ordinary case on a kit.
        const stackedKit = await page.evaluate(`
            window.sheetMusic.editor.clear();
            const pad = (name) =>
                [...document.querySelectorAll(".pad")].find((p) => p.textContent === name);
            const action = (t) => [...document.querySelectorAll(".editor-actions button")]
                .find((b) => b.textContent === t);

            action("Chord").click();
            pad("Kick").click();
            pad("Hi-hat").click();
            await new Promise((r) => setTimeout(r, 500));

            const timeline = window.sheetMusic.timeline;
            return {
                written: window.sheetMusic.editor.score.notes.length,
                drumKeys: timeline.notes.map((n) => n.drumKey),
                onsets: timeline.notes.map((n) => Math.round(n.time * 100) / 100),
            };
        `);
        check("a kick and a hat stack into one beat", stackedKit.written, 1);
        check("both pieces sound", stackedKit.drumKeys, [36, 42]);
        check("at the same moment", stackedKit.onsets, [0, 0]);

        await page.evaluate(`
            window.sheetMusic.editor.clear();
            document.querySelector(".editor-head .primary").click();
            document.getElementById("instrument").value = "piano";
            document.getElementById("instrument").dispatchEvent(new Event("change"));
        `);

        // --- switching to drums and back keeps what was written --------------
        console.log("\nswitching between pitches and drums");
        const switched = await page.evaluate(`
            const editor = window.sheetMusic.editor;
            const pick = async (value) => {
                const select = document.getElementById("instrument");
                select.value = value;
                select.dispatchEvent(new Event("change"));
                await new Promise((r) => setTimeout(r, 500));
            };
            await pick("piano");
            if (document.getElementById("editor").hidden) document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 300));
            if (editor.selected !== null) editor.select(editor.selected);
            editor.stacking = false;
            editor.clear();
            document.querySelectorAll(".length")[2].click();
            const key = (n) => [...document.querySelectorAll(".key")].find((k) => k.getAttribute("aria-label") === n);
            for (const n of ["C4", "D4", "E4", "F4"]) key(n).click();
            await new Promise((r) => setTimeout(r, 400));
            await pick("drums");
            editor.clear();
            [...document.querySelectorAll(".pad")].find((p) => p.textContent === "Kick").click();
            await new Promise((r) => setTimeout(r, 400));
            await pick("piano");
            const chips = () => [...document.querySelectorAll(".chip")].map((c) => c.textContent);
            const pitched = chips();
            await pick("drums");
            const drums = chips();
            await pick("piano");
            const draft = JSON.parse(localStorage.getItem("draft:pitched") ?? "null");
            editor.clear();
            document.querySelector(".editor-head .primary").click();
            return { pitched, drums, savedNotes: draft?.notes?.length ?? 0 };
        `);
        check("back on piano, the notes written are still there", switched.pitched, ["C4", "D4", "E4", "F4"]);
        check("and the drums written in between", switched.drums, ["Kick"]);
        check("and the saved draft was not wiped on the way", switched.savedNotes, 4);

        // --- photos are prepared on the device before upload ----------------
        console.log("\npreparing a photo");
        const photo = await page.evaluate(`
            const { preparePhoto, MAX_EDGE } = await import("./js/photo.js");

            // A camera-sized frame: wide, with the left half dark so we can tell
            // which way up it came out.
            const make = (w, h, type) => new Promise((resolve) => {
                const c = document.createElement("canvas");
                c.width = w; c.height = h;
                const g = c.getContext("2d");
                g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
                g.fillStyle = "#000"; g.fillRect(0, 0, w / 2, h);
                c.toBlob(resolve, type, 0.9);
            });
            const size = async (file) => {
                const b = await createImageBitmap(file);
                return [b.width, b.height];
            };

            // 1. A full-size phone photo comes down to MAX_EDGE.
            const big = new File([await make(4032, 3024, "image/jpeg")], "IMG_0001.jpg", { type: "image/jpeg" });
            const prepared = await preparePhoto(big);

            // 2. The same frame with an EXIF flag saying "turn 90 degrees
            //    clockwise", as a phone held upright writes it. Orientation 6.
            const jpeg = new Uint8Array(await (await make(400, 200, "image/jpeg")).arrayBuffer());
            const exif = [0xFF,0xE1,0x00,0x22, 0x45,0x78,0x69,0x66,0x00,0x00,
                0x49,0x49,0x2A,0x00,0x08,0x00,0x00,0x00, 0x01,0x00,
                0x12,0x01,0x03,0x00,0x01,0x00,0x00,0x00,0x06,0x00,0x00,0x00, 0x00,0x00,0x00,0x00];
            const rotated = new Uint8Array(jpeg.length + exif.length);
            rotated.set(jpeg.slice(0, 2));          // SOI
            rotated.set(exif, 2);                   // APP1 / Exif
            rotated.set(jpeg.slice(2), 2 + exif.length);
            const sideways = new File([rotated], "IMG_0002.jpg", { type: "image/jpeg" });
            const upright = await preparePhoto(sideways);

            // 3. A PDF is left alone.
            const pdf = new File(["%PDF-1.4"], "page.pdf", { type: "application/pdf" });

            return {
                bigIn: await size(big),
                bigOut: await size(prepared),
                bigType: prepared.type,
                shrunk: prepared.size < big.size,
                maxEdge: MAX_EDGE,
                sidewaysOut: await size(upright),
                pdfUntouched: (await preparePhoto(pdf)) === pdf,
            };
        `);
        check("a phone-sized photo is scaled to the long edge", Math.max(...photo.bigOut), photo.maxEdge);
        check("keeping its shape", photo.bigOut[0] / photo.bigOut[1], 4032 / 3024, 0.01);
        check("as a JPEG", photo.bigType, "image/jpeg");
        check("and smaller to send", photo.shrunk, true);
        // 400 x 200 with "rotate 90" applied comes out 200 x 400.
        check("a sideways photo is turned upright", photo.sidewaysOut, [200, 400]);
        check("a PDF is left alone", photo.pdfUntouched, true);

        // --- the clarifying question panel ----------------------------------
        console.log("\nclarifying questions");
        const asked = await page.evaluate(`
            const { QuestionPanel } = await import("./js/questions.js");
            let submitted = null;
            const panel = new QuestionPanel(document.getElementById("questions"), {
                onSubmit: (answers) => { submitted = answers; },
            });
            panel.show([
                { id: "q1", measure: 3, question: "Tie or slur?", options: ["Tie", "Slur"] },
                { id: "q2", measure: 7, question: "Flat or natural?", options: ["Flat", "Natural"] },
            ]);

            const panelEl = document.getElementById("questions");
            const send = panelEl.querySelector(".questions-actions .primary");
            const sendStartsDisabled = send.disabled;

            // Answer the first question.
            panelEl.querySelectorAll(".question")[0].querySelector(".choice").click();
            const afterOne = { chosen: panelEl.querySelectorAll(".choice.chosen").length, enabled: !send.disabled };

            // Type a different answer to the second.
            const second = panelEl.querySelectorAll(".question")[1];
            const other = second.querySelector(".other");
            const hiddenBefore = second.querySelector(".free-text").hidden;
            other.click();
            const field = second.querySelector(".free-text");
            field.value = "A natural";
            field.dispatchEvent(new Event("input"));

            send.click();
            return {
                rendered: panelEl.querySelectorAll(".question").length,
                sendStartsDisabled,
                afterOne,
                freeTextHiddenUntilAsked: hiddenBefore,
                freeTextShown: !field.hidden,
                submitted,
            };
        `);
        check("both questions render", asked.rendered, 2);
        check("send is disabled until something is answered", asked.sendStartsDisabled, true);
        check("choosing an option marks it", asked.afterOne.chosen, 1);
        check("and enables send", asked.afterOne.enabled, true);
        check("the free-text box stays hidden until asked for", asked.freeTextHiddenUntilAsked, true);
        check("and appears when it is", asked.freeTextShown, true);
        check("both answers are submitted", asked.submitted?.length, 2);
        check("including the typed one", asked.submitted?.[1]?.answer, "A natural");

        await page.evaluate(`document.getElementById("questions").hidden = true;`);

        // --- accessibility ---------------------------------------------------
        // axe-core, the standard automated checker, against the page with a
        // score loaded and with the writer open. Any violation fails the run.
        console.log("\naccessibility, in use");
        await loadSample(page, "twinkle.musicxml");
        check("no violations with a score loaded", await auditNow(), []);
        await page.evaluate(`
            window.sheetMusic.editor.clear();
            document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 400));
            window.sheetMusic.editor.clear();
            await new Promise((r) => setTimeout(r, 300));
        `);
        check("no violations with the writer open on an empty draft", await auditNow(), []);
        await page.evaluate(`
            [...document.querySelectorAll(".key")][0].click();
            await new Promise((r) => setTimeout(r, 400));
        `);
        check("or with notes in the strip", await auditNow(), []);
        await page.evaluate(`
            window.sheetMusic.editor.clear();
            document.querySelector(".editor-head .primary").click();
        `);

        // --- dark mode -------------------------------------------------------
        // Everything above runs in the light theme; the dark one gets its own
        // audit, and the two things that went wrong in it before.
        console.log("\ndark mode");
        await scheme("dark");
        await loadSample(page, "twinkle.musicxml");
        check("no violations with a score loaded", await auditNow(), []);
        const dark = await page.evaluate(`
            document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 400));
            [...document.querySelectorAll(".key")][0].click();
            await new Promise((r) => setTimeout(r, 400));
            const key = getComputedStyle(document.querySelector(".key.black"));
            return {
                scheme: getComputedStyle(document.documentElement).colorScheme,
                edge: key.borderTopColor,
                fill: key.backgroundColor,
                panel: getComputedStyle(document.getElementById("editor")).backgroundColor,
            };
        `);
        check("no violations with the writer open", await auditNow(), []);
        check("native controls follow the theme", dark.scheme, "light dark");
        check("a black key has an edge of another colour", dark.edge !== dark.fill, true);
        check("and stands out from the panel", dark.fill !== dark.panel, true);
        await page.evaluate(`
            window.sheetMusic.editor.clear();
            document.querySelector(".editor-head .primary").click();
        `);
        await scheme("light");

        // --- a file that is not sheet music ---------------------------------
        console.log("\nbad input");
        // The app is supposed to log this one, so it is not a problem.
        page.expect(/does not look like MusicXML/);
        const rejected = await page.evaluate(`
            const file = new File(["not music at all"], "junk.musicxml", { type: "text/xml" });
            const input = document.getElementById("file");
            const transfer = new DataTransfer();
            transfer.items.add(file);
            input.files = transfer.files;
            input.dispatchEvent(new Event("change"));
            await new Promise((r) => setTimeout(r, 1500));
            const status = document.getElementById("status");
            return { text: status.textContent, kind: status.className };
        `);
        check("an unreadable file reports an error", rejected.kind.includes("error"), true);
        check("and says so in the status", rejected.text.length > 0, true, rejected.text);

        // --- a draft survives a reload ---------------------------------------
        // Edit belongs to the written score: once something else is loaded it
        // would reopen the old score over it.
        console.log("\nedit follows the written score");
        const editButton = await page.evaluate(`
            const editor = window.sheetMusic.editor;
            if (document.getElementById("editor").hidden) document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 300));
            if (editor.selected !== null) editor.select(editor.selected);
            editor.stacking = false;
            editor.clear();
            document.querySelector(".key").click();
            // Done straight away, while that note is still being engraved.
            [...document.querySelectorAll("#editor button")].find((b) => b.textContent === "Done").click();
            await new Promise((r) => setTimeout(r, 500));
            const edit = document.getElementById("edit-score");
            const out = { afterDone: !edit.hidden };
            await window.sheetMusic.loadSample("twinkle.musicxml");
            out.afterSample = !edit.hidden;
            await window.sheetMusic.loadSample("groove.mid");
            out.afterMidi = !edit.hidden;
            return out;
        `);
        check("Edit is offered for the score you wrote", editButton.afterDone, true);
        check("but not once a sample replaces it", editButton.afterSample, false);
        check("nor a MIDI file", editButton.afterMidi, false);

        // --- tapping a note on the score selects it ---------------------------
        // Real mouse events at where the notes are drawn, so the hit-testing
        // is what gets tested, not a call into the app.
        console.log("\ntapping a note on the score");
        const tapAt = async (x, y) => {
            for (const type of ["mousePressed", "mouseReleased"]) {
                await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
            }
            await new Promise((r) => setTimeout(r, 500));
            return page.evaluate(`
                return {
                    open: !document.getElementById("editor").hidden,
                    selected: window.sheetMusic.editor.selected,
                    chip: document.querySelector(".chip.selected")?.textContent ?? null,
                };
            `);
        };
        // Where each note and rest is drawn right now. The score re-engraves
        // when the writer opens or closes, so this is asked afresh every time.
        const drawn = () => page.evaluate(`
            const out = [];
            const sheet = window.sheetMusic.score.osmd.GraphicSheet;
            for (const staves of sheet.MeasureList) for (const measure of staves)
                for (const entry of measure.staffEntries) for (const voice of entry.graphicalVoiceEntries)
                    for (const note of voice.notes) {
                        const box = note.getSVGGElement().getBoundingClientRect();
                        out.push({
                            whole: note.sourceNote.getAbsoluteTimestamp().RealValue,
                            rest: note.sourceNote.isRest(),
                            x: box.left + box.width / 2,
                            y: box.top + box.height / 2,
                            bottom: box.bottom,
                        });
                    }
            return out;
        `);
        const noteAt = async (whole, rest = false) =>
            (await drawn()).find((d) => Math.abs(d.whole - whole) < 1e-6 && d.rest === rest);

        // A laptop first, with the writer as a panel beside the score. The
        // default headless window is narrow enough for the docked sheet,
        // which would cover the notes being tapped.
        await page.send("Emulation.setDeviceMetricsOverride", {
            width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
        });

        await page.evaluate(`
            const editor = window.sheetMusic.editor;
            document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 300));
            if (editor.selected !== null) editor.select(editor.selected);
            editor.stacking = false;
            editor.clear();
            const key = (n) => [...document.querySelectorAll(".key")]
                .find((k) => k.getAttribute("aria-label") === n);
            const length = (name) => [...document.querySelectorAll(".length")]
                .find((b) => b.getAttribute("aria-label") === name);
            // C D E, then an F that crosses the barline and is drawn as two
            // tied halves, then G - and rests fill out the last bar.
            length("quarter note").click();
            for (const n of ["C4", "D4", "E4"]) key(n).click();
            length("half note").click();
            key("F4").click();
            length("quarter note").click();
            key("G4").click();
            await new Promise((r) => setTimeout(r, 600));
            [...document.querySelectorAll("#editor button")].find((b) => b.textContent === "Done").click();
            document.getElementById("score").scrollIntoView({ block: "center" });
            await new Promise((r) => setTimeout(r, 600));
        `);

        // With the writer shut, a tap goes to the note: paused there, lit.
        let target = await noteAt(0.25);
        const tapShut = await tapAt(target.x, target.y);
        const wentThere = await page.evaluate(`
            const { player, score } = window.sheetMusic;
            return { state: player.state, at: Math.round(player.position() * 100) / 100, step: score.stepIndex };
        `);
        check("with the writer shut, a tap goes to the note, paused there",
            [tapShut.open, wentThere.state, wentThere.at, wentThere.step], [false, "paused", 0.6, 1]);

        // With it open, the tap also selects the note for editing.
        await page.evaluate(`
            document.getElementById("edit-score").click();
            await new Promise((r) => setTimeout(r, 700));
        `);
        target = await noteAt(0.25);
        const tapD = await tapAt(target.x, target.y);
        check("with the writer open, it is selected for editing too", [tapD.open, tapD.selected, tapD.chip], [true, 1, "D4"]);

        target = await noteAt(1);
        const tapTied = await tapAt(target.x, target.y);
        check("the far half of a tied note selects the note", [tapTied.selected, tapTied.chip], [3, "F4"]);

        target = await noteAt(1.25);
        const tapNear = await tapAt(target.x, target.bottom + 12);
        check("a tap just below a note still finds it", [tapNear.selected, tapNear.chip], [4, "G4"]);

        const corner = await page.evaluate(`
            const box = document.getElementById("score").getBoundingClientRect();
            return { x: box.left + 6, y: box.top + 6 };
        `);
        const tapBlank = await tapAt(corner.x, corner.y);
        check("a tap nowhere near a note changes nothing", tapBlank.selected, 4);

        target = await noteAt(1.5, true);
        const tapRest = await tapAt(target.x, target.y);
        check("tapping past the end goes back to adding notes", tapRest.selected, null);

        // On a phone, with the writer docked over the bottom of the screen.
        await page.send("Emulation.setDeviceMetricsOverride", {
            width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
        });
        await page.evaluate(`
            document.getElementById("score").scrollIntoView({ block: "start" });
            await new Promise((r) => setTimeout(r, 900));
        `);
        target = await noteAt(0.5);
        const tapPhone = await tapAt(target.x, target.y);
        check("on a phone too", [tapPhone.selected, tapPhone.chip], [2, "E4"]);
        await page.send("Emulation.setDeviceMetricsOverride", {
            width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
        });
        await new Promise((r) => setTimeout(r, 300));

        // Only the written score is the writer's to select from.
        await page.evaluate(`
            const editor = window.sheetMusic.editor;
            if (editor.selected !== null) editor.select(editor.selected);
            await window.sheetMusic.loadSample("twinkle.musicxml");
            document.getElementById("score").scrollIntoView({ block: "center" });
            await new Promise((r) => setTimeout(r, 600));
        `);
        target = await noteAt(0.25);
        const tapSample = await tapAt(target.x, target.y);
        check("a loaded piece's notes are not the writer's", tapSample.selected, null);
        await page.evaluate(`window.sheetMusic.editor.clear();`);
        await page.send("Emulation.clearDeviceMetricsOverride");

        console.log("\ndrafts survive a reload");
        await page.evaluate(`
            const editor = window.sheetMusic.editor;
            if (document.getElementById("editor").hidden) document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 300));
            if (editor.selected !== null) editor.select(editor.selected);
            // An earlier section leaves Stack on; this one writes single notes.
            editor.stacking = false;
            editor.clear();
            const key = (n) => [...document.querySelectorAll(".key")]
                .find((k) => k.getAttribute("aria-label") === n);
            for (const n of ["C4", "E4", "G4"]) { key(n).click(); await new Promise((r) => setTimeout(r, 60)); }
            const title = document.querySelector(".editor-title");
            title.value = "Survives";
            title.dispatchEvent(new Event("input"));
            await new Promise((r) => setTimeout(r, 500));
        `);
        await page.send("Page.reload", { ignoreCache: true });
        await new Promise((r) => setTimeout(r, 600));
        await waitFor(() => page.evaluate("return Boolean(window.sheetMusic)"), {
            what: "the app to boot again",
        });
        const restored = await page.evaluate(`
            document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 900));
            const out = {
                chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent),
                title: document.querySelector(".editor-title").value,
                said: document.getElementById("status").textContent,
            };
            window.sheetMusic.editor.clear();
            await new Promise((r) => setTimeout(r, 400));
            out.savedAfterClear = JSON.parse(localStorage.getItem("draft:pitched") ?? "{}").notes?.length ?? 0;
            document.querySelector(".editor-head .primary").click();
            return out;
        `);
        check("the notes written come back after a reload", restored.chips, ["C4", "E4", "G4"]);
        check("with their title", restored.title, "Survives");
        check("and it says so", /Picked up your draft, 3 notes/.test(restored.said), true);
        check("Clear starts a fresh draft", restored.savedAfterClear, 0);

        // --- typing notes on a laptop ----------------------------------------
        // --- the space bar ---------------------------------------------------
        // Space plays and pauses - except on a button reached with the
        // keyboard, which it presses, as it does everywhere else on the web.
        console.log("\nthe space bar");
        await page.send("Emulation.setDeviceMetricsOverride", {
            width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
        });
        const realKey = async (key, code, keyCode) => {
            await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, text: key === " " ? " " : undefined });
            await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
            await new Promise((r) => setTimeout(r, 400));
        };
        await loadSample(page, "twinkle.musicxml");
        // Tab onto the Drum groove sample from the control before it.
        await page.evaluate(`
            document.getElementById("setup-wrap").open = true;
            const samples = document.querySelector("details.try");
            samples.open = true;
            const buttons = [...samples.querySelectorAll("button")];
            const drums = buttons.findIndex((b) => /Drum/.test(b.textContent));
            buttons[drums - 1].focus();
        `);
        await realKey("Tab", "Tab", 9);
        await realKey(" ", "Space", 32);
        await new Promise((r) => setTimeout(r, 800));
        const tabbed = await page.evaluate(`
            const out = { piece: document.getElementById("piece-name").textContent, state: window.sheetMusic.player.state };
            window.sheetMusic.player.stop();
            return out;
        `);
        check("Space presses a sample button reached by Tab", tabbed.piece, "Drum Groove");
        check("rather than playing", tabbed.state, "stopped");

        // Click a piano key with the mouse: it keeps focus, but Space plays.
        const clicked = await page.evaluate(`
            document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 400));
            window.sheetMusic.editor.clear();
            await new Promise((r) => setTimeout(r, 200));
            const r = document.querySelectorAll(".key")[0].getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height - 10 };
        `);
        for (const type of ["mousePressed", "mouseReleased"]) {
            await page.send("Input.dispatchMouseEvent", { type, x: clicked.x, y: clicked.y, button: "left", clickCount: 1 });
        }
        await new Promise((r) => setTimeout(r, 400));
        await realKey(" ", "Space", 32);
        const afterClick = await page.evaluate(`
            const out = {
                notes: window.sheetMusic.editor.score.notes.length,
                state: window.sheetMusic.player.state,
                focusedKey: document.activeElement.classList.contains("key"),
            };
            window.sheetMusic.player.stop();
            window.sheetMusic.editor.clear();
            document.querySelector(".editor-head .primary").click();
            return out;
        `);
        check("a clicked piano key keeps focus", afterClick.focusedKey, true);
        check("and Space then plays", afterClick.state, "playing");
        check("without writing the key again", afterClick.notes, 1);
        await page.send("Emulation.clearDeviceMetricsOverride");

        console.log("\nkeyboard entry");
        await page.evaluate(`
            document.getElementById("write-music").click();
            await new Promise((r) => setTimeout(r, 300));
            const editor = window.sheetMusic.editor;
            editor.stacking = false;
            editor.clear();
            document.querySelectorAll(".length")[2].click();
            document.activeElement?.blur();
        `);
        // Real key events through the browser, not synthetic DOM events.
        const press = async (key) => {
            const code = { ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", Backspace: "Backspace", ".": "Period" }[key]
                ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : `Digit${key}`);
            await page.send("Input.dispatchKeyEvent", {
                type: "keyDown", key, code,
                text: key.length === 1 ? key : undefined,
                windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
            });
            await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code });
            await new Promise((r) => setTimeout(r, 60));
        };
        for (const key of ["c", "d", "e", "2", "g", "4", ".", "ArrowUp", "c", "r", "Backspace"]) {
            await press(key);
        }
        await new Promise((r) => setTimeout(r, 600));
        const typed = await page.evaluate(`
            const t = window.sheetMusic.timeline;
            const out = {
                chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent),
                durations: t.notes.map((n) => Math.round(n.duration * 100) / 100),
            };
            window.sheetMusic.editor.clear();
            document.querySelector(".editor-head .primary").click();
            return out;
        `);
        check("letters write notes, ↑ moves up an octave, . dots", typed.chips, ["C4", "D4", "E4", "G4", "C5."]);
        // quarter, quarter, quarter, half, dotted quarter at 100 BPM
        check("number keys set the lengths", typed.durations, [0.6, 0.6, 0.6, 1.2, 0.9]);

        // --- optional: real playback ----------------------------------------
        if (WITH_AUDIO) {
            // The checks above leave whatever they loaded last on screen - the
            // writer's cleared score, or a file that failed to load. Playback
            // needs a known score with notes in it.
            console.log("\nplayback (audio clock)");
            await loadSample(page, "twinkle.musicxml");
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

            console.log("\ncount in");
            const counted = await page.evaluate(`
                const { player } = window.sheetMusic;
                player.setOption("countIn", true);
                await player.play();
                const atStart = player.position();
                await new Promise((r) => setTimeout(r, 400));
                const later = player.position();
                player.stop();
                player.setOption("countIn", false);
                return { atStart, later };
            `);
            // Four clicks at 100 BPM is 2.4s of count-in before the first note.
            check("playback starts before bar 1", counted.atStart < -2.2, true);
            check("and counts towards it", counted.later > counted.atStart, true);

            // Moving the tempo or a toggle mid-count-in rebuilds the queue; the
            // clicks still to come have to be in the rebuilt one.
            const recounted = await page.evaluate(`
                const { player, timeline } = window.sheetMusic;
                player.setOption("countIn", true);
                await player.play();
                // Schedule as a page in view does: headless counts as hidden,
                // which schedules seconds ahead and empties the queue early.
                player.lookahead = 0.15;
                await new Promise((r) => setTimeout(r, 300));
                const queued = () => player.events.slice(player.eventIndex)
                    .filter((e) => e.click && e.time < 0).map((e) => e.time);
                const due = () => timeline.countIn
                    .filter((b) => b.time >= player.scheduledUntil - 1e-6).map((b) => b.time);
                player.setTempo(80);
                const tempo = { queued: queued(), due: due() };
                player.setOption("metronome", true);
                const toggle = { queued: queued(), due: due() };
                player.stop();
                player.setOption("countIn", false);
                player.setOption("metronome", false);
                player.setTempo(timeline.bpm);
                return { tempo, toggle };
            `);
            check("clicks were still due when the tempo moved", recounted.tempo.due.length > 0, true);
            check("and the count-in survives the tempo change", recounted.tempo.queued, recounted.tempo.due);
            check("and switching the metronome on", recounted.toggle.queued, recounted.toggle.due);

            // Seeking while it plays carries on from the new point.
            const seekingWhilePlaying = await page.evaluate(`
                const { player } = window.sheetMusic;
                await window.sheetMusic.loadSample("timing-test.musicxml");
                await player.play();
                await new Promise((r) => setTimeout(r, 500));
                player.seek(15);
                await new Promise((r) => setTimeout(r, 600));
                const out = { state: player.state, at: player.position() };
                // Grabbing the bar pauses; letting go plays on from where it lands.
                const seek = document.getElementById("seek");
                seek.dispatchEvent(new PointerEvent("pointerdown"));
                out.grabbed = player.state;
                seek.value = "5";
                seek.dispatchEvent(new Event("input"));
                seek.dispatchEvent(new Event("change"));
                await new Promise((r) => setTimeout(r, 600));
                out.released = { state: player.state, at: player.position() };
                player.stop();
                return out;
            `);
            // Tapping a note while it plays pauses there.
            const tappedWhilePlaying = await page.evaluate(`
                const { player } = window.sheetMusic;
                await player.play();
                await new Promise((r) => setTimeout(r, 400));
                const sheet = window.sheetMusic.score.osmd.GraphicSheet;
                let target = null;
                for (const staves of sheet.MeasureList) for (const measure of staves)
                    for (const entry of measure.staffEntries) for (const voice of entry.graphicalVoiceEntries)
                        for (const note of voice.notes) {
                            if (!target && Math.abs(note.sourceNote.getAbsoluteTimestamp().RealValue - 1) < 1e-6) {
                                target = note.getSVGGElement().getBoundingClientRect();
                            }
                        }
                document.getElementById("score").dispatchEvent(new MouseEvent("click", {
                    bubbles: true, clientX: target.left + target.width / 2, clientY: target.top + target.height / 2,
                }));
                await new Promise((r) => setTimeout(r, 300));
                const out = { state: player.state, at: player.position() };
                player.stop();
                return out;
            `);
            check("tapping a note while it plays pauses there", [tappedWhilePlaying.state, tappedWhilePlaying.at], ["paused", 2.5]);
            check("seeking while playing carries on from there", seekingWhilePlaying.state, "playing");
            check("at the new point", seekingWhilePlaying.at > 15 && seekingWhilePlaying.at < 16.5, true);
            check("grabbing the seek bar pauses", seekingWhilePlaying.grabbed, "paused");
            check("and letting go plays on from where it lands",
                [seekingWhilePlaying.released.state, seekingWhilePlaying.released.at > 5 && seekingWhilePlaying.released.at < 6.5],
                ["playing", true]);

            console.log("\npause, resume and tempo");
            const transport = await page.evaluate(`
                const { player } = window.sheetMusic;
                await player.play();
                await new Promise((r) => setTimeout(r, 600));
                player.pause();
                const paused = player.position();
                await new Promise((r) => setTimeout(r, 300));
                const stillPaused = player.position();

                // Resuming schedules the music to reach the paused position
                // after the lead-in, so give that a moment to elapse.
                await player.play();
                await new Promise((r) => setTimeout(r, 300));
                const resumed = player.position();

                player.setTempo(200);
                const beforeTempoChange = player.position();
                await new Promise((r) => setTimeout(r, 200));
                const afterTempoChange = player.position();
                const state = player.state;
                player.stop();
                player.setTempo(100);
                return { paused, stillPaused, resumed, beforeTempoChange, afterTempoChange, state };
            `);
            check("pause holds the position", transport.stillPaused, transport.paused, 1e-9);
            check("resume carries on from there", transport.resumed > transport.paused, true);
            check(
                "a tempo change keeps the position",
                transport.afterTempoChange > transport.beforeTempoChange - 0.15,
                true,
            );
            check("a tempo change does not stop playback", transport.state, "playing");
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
