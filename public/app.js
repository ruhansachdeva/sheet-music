// Front end controller: picks a loader for the uploaded file, wires the
// transport controls to the player, and drives the highlighting.

import { INSTRUMENTS, DEFAULT_INSTRUMENT } from "./js/instruments.js";
import { Score } from "./js/score.js";
import { PianoRoll } from "./js/midi.js";
import { Player } from "./js/player.js";
import { QuestionPanel } from "./js/questions.js";

const ui = {
    file: document.getElementById("file"),
    instrument: document.getElementById("instrument"),
    status: document.getElementById("status"),
    controls: document.getElementById("controls"),
    play: document.getElementById("play"),
    stop: document.getElementById("stop"),
    tempo: document.getElementById("tempo"),
    tempoValue: document.getElementById("tempo-value"),
    tempoReset: document.getElementById("tempo-reset"),
    countIn: document.getElementById("count-in"),
    metronome: document.getElementById("metronome"),
    position: document.getElementById("position"),
    zoom: document.getElementById("zoom"),
    zoomValue: document.getElementById("zoom-value"),
    piece: document.getElementById("piece"),
    pieceName: document.getElementById("piece-name"),
    download: document.getElementById("download"),
    score: document.getElementById("score"),
    roll: document.getElementById("roll"),
    questions: document.getElementById("questions"),
    samples: document.querySelectorAll("[data-sample]"),
};

const score = new Score(ui.score);
const pianoRoll = new PianoRoll(ui.roll);
const player = new Player({
    onPosition: handlePosition,
    onState: handleState,
    onInstrumentLoading: (loading, detail) => {
        // Samples load in the background, and must never bury an error the
        // user still needs to read.
        if (statusKind === "error") return;

        if (loading) {
            const percent = Math.round((detail?.progress ?? 0) * 100);
            setStatus(`Loading ${detail?.instrument ?? "instrument"} samples… ${percent}%`, "busy");
        } else if (statusKind === "busy") {
            clearStatus();
        }
    },
});
const questionPanel = new QuestionPanel(ui.questions, { onSubmit: sendAnswers });

/** What is on screen: a rendered score, or a piano roll for a MIDI file. */
let view = null;
let timeline = null;
let statusKind = null;

/** The photo or PDF behind the current score, kept so answers can be applied to it. */
let sourceFile = null;

/** The MusicXML on screen, which a correction round starts from. */
let currentMusicXml = "";

// --- setup ------------------------------------------------------------------

for (const [key, definition] of Object.entries(INSTRUMENTS)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = definition.label;
    ui.instrument.appendChild(option);
}
ui.instrument.value = DEFAULT_INSTRUMENT;
player.setInstrument(DEFAULT_INSTRUMENT);

ui.instrument.addEventListener("change", () => {
    player.setInstrument(ui.instrument.value).catch(reportError);
});

ui.file.addEventListener("change", () => {
    const file = ui.file.files?.[0];
    if (file) loadFile(file);
});

for (const button of ui.samples) {
    button.addEventListener("click", () => loadSample(button.dataset.sample));
}

// Dropping a file anywhere on the page loads it.
document.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    document.body.classList.add("dropping");
});

document.addEventListener("dragleave", (event) => {
    if (event.relatedTarget === null) document.body.classList.remove("dropping");
});

document.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    document.body.classList.remove("dropping");
    loadFile(file);
});

ui.play.addEventListener("click", () => Promise.resolve(player.toggle()).catch(reportError));
ui.stop.addEventListener("click", () => player.stop());

ui.tempo.addEventListener("input", () => {
    const bpm = Number(ui.tempo.value);
    ui.tempoValue.textContent = `${bpm} BPM`;
    player.setTempo(bpm);
    ui.tempoReset.hidden = !timeline || bpm === timeline.bpm;
});

ui.tempoReset.addEventListener("click", () => {
    if (timeline) setTempo(timeline);
});

ui.zoom.addEventListener("change", () => {
    const percent = Number(ui.zoom.value);
    ui.zoomValue.textContent = `${percent}%`;
    if (view === score) score.setZoom(percent / 100);
    else ui.roll.style.setProperty("--roll-scale", String(percent / 100));
});

ui.countIn.addEventListener("change", () => player.setOption("countIn", ui.countIn.checked));
ui.metronome.addEventListener("change", () =>
    player.setOption("metronome", ui.metronome.checked),
);

document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, select, textarea")) return;
    if (event.code === "Space" && !ui.controls.hidden) {
        event.preventDefault();
        Promise.resolve(player.toggle()).catch(reportError);
    }
});

function reportError(error) {
    console.error(error);
    setStatus(error.message, "error");
}

// --- loading ----------------------------------------------------------------

async function loadFile(file) {
    const name = file.name.toLowerCase();
    player.stop();

    try {
        if (name.endsWith(".mxl")) {
            sourceFile = null;
            questionPanel.hide();
            await showScore(file, file.name); // OSMD unzips a .mxl Blob itself
        } else if (name.endsWith(".musicxml") || name.endsWith(".xml")) {
            sourceFile = null;
            questionPanel.hide();
            await showScore(await file.text(), file.name);
        } else if (name.endsWith(".mid") || name.endsWith(".midi")) {
            await showPianoRoll(await file.arrayBuffer(), file.name);
        } else if (file.type.startsWith("image/") || file.type === "application/pdf") {
            await transcribe(file);
        } else {
            setStatus(`I don't know how to read ${file.name}.`, "error");
        }
    } catch (error) {
        console.error(error);
        setStatus(`Could not load that file: ${error.message}`, "error");
    }
}

async function loadSample(name) {
    player.stop();
    setStatus(`Loading ${name}…`, "busy");
    sourceFile = null;
    questionPanel.hide();

    try {
        const response = await fetch(`/samples/${name}`);
        if (!response.ok) throw new Error(`${response.status}`);

        if (name.endsWith(".mid") || name.endsWith(".midi")) {
            await showPianoRoll(await response.arrayBuffer(), name);
        } else {
            await showScore(await response.text(), name);
        }
    } catch (error) {
        console.error(error);
        setStatus(`Could not load the sample: ${error.message}`, "error");
    }
}

/** Renders MusicXML (a string, or a Blob for .mxl) and makes it playable. */
async function showScore(content, label) {
    setStatus("Rendering the score…", "busy");
    if (typeof content === "string") currentMusicXml = content;

    ui.roll.hidden = true;
    pianoRoll.clear();
    ui.score.hidden = false;

    timeline = await score.load(content);
    view = score;
    ready(score.title || label, timeline);
}

async function showPianoRoll(arrayBuffer, label) {
    setStatus("Reading the MIDI file…", "busy");
    sourceFile = null;
    questionPanel.hide();

    ui.score.hidden = true;
    score.clear();
    ui.roll.hidden = false;

    timeline = await pianoRoll.load(arrayBuffer);
    view = pianoRoll;
    ready(pianoRoll.title || label, timeline, "MIDI is already at concert pitch, so it plays untransposed.");
}

/** A photo or a PDF: Claude reads it into MusicXML, then we render that. */
async function transcribe(file) {
    setStatus("Claude is reading your sheet music. This can take a minute…", "busy");
    questionPanel.hide();

    const body = new FormData();
    body.append("file", file);
    body.append("instrument", ui.instrument.value);

    const result = await post("/api/transcribe", body);
    await showScore(result.musicxml, result.title);
    sourceFile = file;
    ui.pieceName.textContent = result.title ? `${result.title} — read by Claude` : "Read by Claude";
    offerDownload(result.title);
    questionPanel.show(result.questions);
}

/** Sends my answers back so Claude can correct the MusicXML. */
async function sendAnswers(answers) {
    if (!sourceFile) return;
    questionPanel.setBusy(true);
    setStatus("Claude is applying your answers…", "busy");

    try {
        const body = new FormData();
        body.append("file", sourceFile);
        body.append("instrument", ui.instrument.value);
        body.append("musicxml", currentMusicXml);
        body.append("answers", JSON.stringify(answers));

        const result = await post("/api/refine", body);
        await showScore(result.musicxml, result.title);
        ui.pieceName.textContent = `${result.title} — corrected`;
        offerDownload(result.title);
        questionPanel.show(result.questions);
    } catch (error) {
        setStatus(`Could not apply the answers: ${error.message}`, "error");
    } finally {
        questionPanel.setBusy(false);
    }
}

async function post(url, body) {
    const response = await fetch(url, { method: "POST", body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
}

/** Shared tail of every loader: hand the timeline to the player, show controls. */
function ready(label, loadedTimeline, note = "") {
    player.setTimeline(loadedTimeline);
    setTempo(loadedTimeline);

    ui.controls.hidden = false;
    ui.piece.hidden = false;
    ui.pieceName.textContent = label;
    offerDownload(label);

    const tempoNote = loadedTimeline.scoreBpm
        ? `score tempo ${loadedTimeline.scoreBpm} BPM`
        : "no tempo marking, defaulting to 100 BPM";
    const parts = [`${loadedTimeline.notes.length} notes`, tempoNote];
    if (note) parts.push(note);
    setStatus(parts.join(" · "), "info");
}

/** Puts the slider back on the score's own tempo (or 100 BPM if it has none). */
function setTempo(loadedTimeline) {
    const bpm = loadedTimeline.bpm;
    // A score can be marked faster or slower than the slider's usual range.
    ui.tempo.min = Math.min(30, bpm);
    ui.tempo.max = Math.max(240, bpm);
    ui.tempo.value = bpm;
    ui.tempoValue.textContent = `${bpm} BPM`;
    player.setTempo(bpm);
    ui.tempoReset.hidden = true;
    ui.tempoReset.textContent = loadedTimeline.scoreBpm
        ? `Reset to score tempo (${loadedTimeline.scoreBpm} BPM)`
        : "Reset to 100 BPM";
}

// --- playback feedback ------------------------------------------------------

function handlePosition(time, step) {
    if (view === score) score.showStep(step);
    else if (view === pianoRoll) pianoRoll.showTime(time);
    showPosition(time, step);
}

/**
 * Offers the MusicXML on screen as a download. Worth having for a score Claude
 * read off a photo: that transcription is otherwise lost on reload.
 */
function offerDownload(label) {
    if (ui.download.href) URL.revokeObjectURL(ui.download.href);

    if (!currentMusicXml || view !== score) {
        ui.download.hidden = true;
        ui.download.removeAttribute("href");
        return;
    }

    const blob = new Blob([currentMusicXml], { type: "application/vnd.recordare.musicxml+xml" });
    const name = (label || "score").replace(/\.(musicxml|xml|mxl|png|jpe?g|pdf)$/i, "");
    ui.download.href = URL.createObjectURL(blob);
    ui.download.download = `${name.replace(/[^\w -]+/g, "").trim() || "score"}.musicxml`;
    ui.download.hidden = false;
}

/** The bar number while a score plays, or the elapsed time for a piano roll. */
function showPosition(time, step) {
    if (!timeline) return;

    if (time < 0) {
        ui.position.textContent = "counting in";
        return;
    }
    const bar = timeline.steps[step]?.measure;
    ui.position.textContent = bar ? `bar ${bar}` : `${Math.max(time, 0).toFixed(1)}s`;
}

function handleState(state) {
    ui.play.textContent = state === "playing" ? "Pause" : "Play";
    ui.play.classList.toggle("playing", state === "playing");
    if (state === "stopped") {
        view?.reset();
        if (timeline) ui.position.textContent = timeline.isPianoRoll ? "0.0s" : "bar 1";
    }
}

function setStatus(message, kind) {
    statusKind = kind;
    if (kind === "info") lastInfo = message;
    ui.status.textContent = message;
    ui.status.hidden = false;
    ui.status.className = `status ${kind}`;
}

/** Busy messages are temporary: when one clears, show what is loaded again. */
function clearStatus() {
    statusKind = null;
    if (lastInfo) setStatus(lastInfo, "info");
    else ui.status.hidden = true;
}

let lastInfo = "";

// A handle for poking at the running app from the browser console, and for the
// checks in tools/browser-test.mjs.
window.sheetMusic = {
    player,
    score,
    pianoRoll,
    get timeline() {
        return timeline;
    },
    loadSample,
};
