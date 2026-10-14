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
