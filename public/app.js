// Front end controller: picks a loader for the uploaded file, wires the
// transport controls to the player, and drives the highlighting.

import { INSTRUMENTS, DEFAULT_INSTRUMENT } from "./js/instruments.js";
import { Score } from "./js/score.js";
import { PianoRoll } from "./js/midi.js";
import { Player } from "./js/player.js";
import { QuestionPanel } from "./js/questions.js";
import { Editor } from "./js/editor/ui.js";
import { preparePhoto } from "./js/photo.js";

const ui = {
    file: document.getElementById("file"),
    chooseFile: document.getElementById("choose-file"),
    takePhoto: document.getElementById("take-photo"),
    camera: document.getElementById("camera"),
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
    more: document.getElementById("more"),
    moreControls: document.getElementById("more-controls"),
    zoom: document.getElementById("zoom"),
    zoomValue: document.getElementById("zoom-value"),
    zoomFit: document.getElementById("zoom-fit"),
    piece: document.getElementById("piece"),
    pieceName: document.getElementById("piece-name"),
    download: document.getElementById("download"),
    editScore: document.getElementById("edit-score"),
    score: document.getElementById("score"),
    roll: document.getElementById("roll"),
    questions: document.getElementById("questions"),
    samples: document.querySelectorAll("[data-sample]"),
    setupWrap: document.getElementById("setup-wrap"),
    noReader: document.getElementById("no-reader"),
    writeMusic: document.getElementById("write-music"),
    editor: document.getElementById("editor"),
    setupTitle: document.getElementById("setup-title"),
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

// Writing a score by hand. Every change re-engraves it, so you see and hear
// what you are writing as you write it.
const editor = new Editor(ui.editor, {
    onChange: (written) => showWrittenScore(written),
    onPlay: () => Promise.resolve(player.toggle()).catch(reportError),
    onSelect: (seconds) => highlightWritten(seconds),
    onPreview: (midi) => player.preview(midi).catch(reportError),
    onPreviewDrum: (gm) => player.previewDrum(gm).catch(reportError),
    onClose: () => {
        setStatus("Saved. Press play to hear it.", "info");
        ui.editScore.hidden = !writtenOnScreen;
        document.body.classList.remove("writing");
    },
});

// On a phone the writer is a sheet docked to the bottom, like a keyboard. The
// page reserves its height so the score can always scroll clear of it.
new ResizeObserver(() => {
    const height = ui.editor.hidden ? 0 : ui.editor.offsetHeight;
    document.documentElement.style.setProperty("--sheet-height", `${height}px`);
}).observe(ui.editor);

/** Lights up the note being edited on the score, or nothing. */
function highlightWritten(seconds) {
    if (view !== score || !timeline) return;
    if (seconds === null || seconds === undefined) {
        score.reset();
        return;
    }
    const step = timeline.steps.findIndex((s) => Math.abs(s.time - seconds) < 0.01);
    if (step >= 0) score.showStep(step);
}

/**
 * Keeps the newest notes in view while writing: just above the docked sheet on
 * a phone, or at the bottom of the window beside the side panel on a laptop.
 */
function revealNewest() {
    if (!document.body.classList.contains("writing")) return;
    const bottom = ui.score.getBoundingClientRect().bottom;
    const placement = getComputedStyle(ui.editor).position;

    if (placement === "fixed") {
        const room = window.innerHeight - ui.editor.offsetHeight - 12;
        window.scrollBy({ top: bottom - room, behavior: "smooth" });
    } else if (placement === "sticky") {
        const overflow = bottom - (window.innerHeight - 16);
        if (overflow > 0) window.scrollBy({ top: overflow, behavior: "smooth" });
    }
}

/**
 * A draft is kept in the browser's own storage as you write, one for pitched
 * music and one for drums, so a reload - or a phone discarding the tab while
 * you were in another app - does not throw the work away. Storage can be
 * missing or full (private browsing), so every access is guarded.
 */
/** A message to show once the next render of the written score is done, so
 *  the render's own status line does not immediately replace it. */
let noticeAfterRender = null;

function draftKey(kind) {
    return `draft:${kind}`;
}

function saveDraft(written) {
    try {
        localStorage.setItem(draftKey(written.kind ?? "pitched"), JSON.stringify(written));
    } catch {
        // Not being able to save the draft must not stop the writing.
    }
}

function loadDraft(kind) {
    try {
        const saved = JSON.parse(localStorage.getItem(draftKey(kind)) ?? "null");
        return saved?.notes?.length ? saved : null;
    } catch {
        return null;
    }
}

async function showWrittenScore() {
    saveDraft(editor.score);
    player.stop();
    sourceFile = null;
    questionPanel.hide();
    try {
        await showScore(editor.toMusicXml(), editor.score.title, { written: true });
        if (noticeAfterRender) {
            setStatus(noticeAfterRender, "info");
            noticeAfterRender = null;
        }
        // Re-engraving clears the highlight, so put the selected note's back.
        highlightWritten(editor.selectedOnset());
        if (editor.selected === null) revealNewest();
    } catch (error) {
        reportError(error);
    }
}

/** What is on screen: a rendered score, or a piano roll for a MIDI file. */
let view = null;
let timeline = null;
/** Whether the score on screen is the one in the writer, rather than a
 *  file, a sample or a reading - only that one can be edited. */
let writtenOnScreen = false;

/** The status line: what kind of message it is showing, and the last summary of
 *  the loaded piece, which a passing "busy" message is restored to. */
let statusKind = null;
let lastInfo = "";

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
/**
 * Whether a transcription server is behind this page. The hosted build is
 * static files only, so there is nothing to read a photo with there.
 */
let canRead = true;

/** The provider doing the reading, as the server names it. */
let readerName = "the reader";

async function checkReader() {
    // Three states, and they need different explanations: no server at all
    // (the hosted static build), a server with no key, or a working reader.
    let served = true;
    try {
        const response = await fetch("api/health");
        if (!response.ok) throw new Error("no reader");
        const health = await response.json();
        canRead = Boolean(health.canRead);
        if (health.provider) readerName = health.provider;
    } catch {
        served = false;
        canRead = false;
    }

    if (canRead) return;

    ui.noReader.textContent = served
        ? "No API key is set, so photos and PDFs cannot be read. Add one to .env and " +
          "restart - see the README. Playing and writing music works either way."
        : "This hosted copy is static files only. Playing and writing music works here; " +
          "reading a photo or a PDF needs the app running locally with an API key.";
    ui.noReader.hidden = false;
    ui.takePhoto.hidden = true;
    // Leave the file picker, but stop it offering what it cannot do.
    ui.file.accept = ".musicxml,.xml,.mxl,.mid,.midi";
}

checkReader();

// Until something is loaded, the setup is the page - no point folding it.
ui.setupWrap.classList.add("first-run");

// Pick up last session's instrument, so you are not re-choosing it every time.
const remembered = localStorage.getItem("instrument");
ui.instrument.value = remembered && remembered in INSTRUMENTS ? remembered : DEFAULT_INSTRUMENT;
player.setInstrument(ui.instrument.value).catch(reportError);

ui.instrument.addEventListener("change", () => {
    localStorage.setItem("instrument", ui.instrument.value);
    player.setInstrument(ui.instrument.value).catch(reportError);
    // Writing drums is a different kind of notation, so the writer follows.
    editor.setKind(writingKind());
});

/** Drums are written as unpitched notes on a percussion staff. */
function writingKind() {
    return INSTRUMENTS[ui.instrument.value]?.drums ? "drums" : "pitched";
}

// The real file inputs are hidden: the buttons stand in for them, so they can
// be styled and sized for a thumb.
ui.chooseFile.addEventListener("click", () => ui.file.click());
ui.writeMusic.addEventListener("click", () => {
    ui.editScore.hidden = true;
    document.body.classList.add("writing");

    // Pick up where you left off, and say so - Clear starts a fresh one.
    const draft = loadDraft(writingKind());
    if (draft) {
        const count = draft.notes.length;
        noticeAfterRender =
            `Picked up your draft, ${count} ${count === 1 ? "note" : "notes"}. Clear starts a new one.`;
    }
    editor.open(draft, writingKind());
    // Fetch the samples now, so the first key tapped actually sounds.
    player.warmUp().catch(reportError);
});

// Go back into something you wrote, rather than starting again.
ui.editScore.addEventListener("click", reopenWriter);

function reopenWriter() {
    ui.editScore.hidden = true;
    document.body.classList.add("writing");
    editor.open(editor.score, editor.score.kind);
    player.warmUp().catch(reportError);
}

// Tapping a note on the written score selects it for editing, as tapping its
// chip in the writer does - opening the writer first if it is closed. Tapping
// past the last note goes back to adding at the end.
ui.score.addEventListener("click", (event) => {
    if (!writtenOnScreen || view !== score) return;
    const whole = score.noteAt(event.clientX, event.clientY);
    if (whole === null) return;

    if (!editor.isOpen) reopenWriter();
    const index = editor.indexAt(whole);
    if (index === null) {
        if (editor.selected !== null) editor.select(editor.selected);
    } else if (index !== editor.selected) {
        editor.select(index);
    }
});

// Browsers keep audio suspended until the page has been interacted with, so
// take the first touch as the cue rather than waiting for a note to be played.
for (const event of ["pointerdown", "keydown"]) {
    window.addEventListener(event, () => player.warmUp().catch(() => {}), { once: true });
}
ui.takePhoto.addEventListener("click", () => ui.camera.click());

ui.camera.addEventListener("change", () => {
    const photo = ui.camera.files?.[0];
    if (!photo) return;
    loadFile(photo);
    ui.camera.value = "";
});

// Only offer the camera where there is one: a desktop browser ignores the
// capture attribute, so the button would just reopen the file dialog.
if (window.matchMedia?.("(pointer: coarse)").matches && navigator.mediaDevices?.getUserMedia) {
    ui.takePhoto.hidden = false;
    ui.chooseFile.classList.remove("primary");
}

ui.file.addEventListener("change", () => {
    const file = ui.file.files?.[0];
    if (!file) return;
    loadFile(file);
    // Clear it, so picking the same file again still fires a change event.
    ui.file.value = "";
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

// The docked bar keeps only play, stop and position; the rest slides up.
ui.more.addEventListener("click", () => {
    const open = ui.moreControls.classList.toggle("open");
    ui.more.setAttribute("aria-expanded", String(open));
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
    if (view === score) {
        score.setZoom(percent / 100);
        ui.zoomFit.hidden = false;
    } else {
        ui.roll.style.setProperty("--roll-scale", String(percent / 100));
    }
});

// Back to the size that fits the screen.
ui.zoomFit.addEventListener("click", () => {
    if (view !== score) return;
    showZoom(score.fitAgain());
    ui.zoomFit.hidden = true;
});

ui.countIn.addEventListener("change", () => player.setOption("countIn", ui.countIn.checked));
ui.metronome.addEventListener("change", () =>
    player.setOption("metronome", ui.metronome.checked),
);

document.addEventListener("keydown", (event) => {
    if (event.target instanceof Element && event.target.matches("input, select, textarea")) return;

    // While writing, the keyboard writes notes.
    if (editor.isOpen && editor.handleKey(event)) {
        event.preventDefault();
        return;
    }

    if (event.code === "Space" && !ui.controls.hidden) {
        event.preventDefault();
        Promise.resolve(player.toggle()).catch(reportError);
    }
});

function reportError(error) {
    console.error(error);
    setStatus(error.message, "error");
}

// There is no build step and no framework here, so an unexpected error would
// otherwise only show up in the console.
window.addEventListener("unhandledrejection", (event) => {
    reportError(event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
});

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
            if (!canRead) {
                setStatus(ui.noReader.textContent.trim(), "error");
                return;
            }
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
        const response = await fetch(`samples/${name}`);
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

/**
 * Renders MusicXML (a string, or a Blob for .mxl) and makes it playable.
 * `written` says it is the writer's score, which is known before it renders.
 */
async function showScore(content, label, { written = false } = {}) {
    setStatus("Rendering the score…", "busy");
    if (written) writtenOnScreen = true;
    else showingSomethingElse();
    ui.score.classList.toggle("tappable", writtenOnScreen);
    if (typeof content === "string") currentMusicXml = content;

    ui.roll.hidden = true;
    pianoRoll.clear();
    ui.score.hidden = false;

    timeline = await score.load(content);
    view = score;
    ready(score.title || label, timeline);
}

/**
 * Anything newly put on screen is not the written score until shown to be,
 * so Edit goes - it would otherwise reopen the old written score over it.
 */
function showingSomethingElse() {
    writtenOnScreen = false;
    ui.editScore.hidden = true;
}

async function showPianoRoll(arrayBuffer, label) {
    setStatus("Reading the MIDI file…", "busy");
    showingSomethingElse();
    sourceFile = null;
    questionPanel.hide();

    ui.score.hidden = true;
    score.clear();
    ui.roll.hidden = false;

    timeline = await pianoRoll.load(arrayBuffer);
    view = pianoRoll;
    ready(pianoRoll.title || label, timeline, "MIDI is already at concert pitch, so it plays untransposed.");
}

/** A photo or a PDF: it is read into MusicXML, then rendered like any score. */
async function transcribe(original) {
    questionPanel.hide();
    setStatus("Preparing the photo…", "busy");
    const file = await preparePhoto(original);

    const body = new FormData();
    body.append("file", file);
    body.append("instrument", ui.instrument.value);

    // One read at a time: a second upload mid-request would race the first.
    setUploadsEnabled(false);
    const stopClock = showElapsed(`Reading your sheet music with ${readerName}`);
    let result;
    try {
        result = await post("api/transcribe", body);
    } finally {
        stopClock();
        setUploadsEnabled(true);
    }
    await showScore(result.musicxml, result.title);
    sourceFile = file;
    ui.pieceName.textContent = result.title
        ? `${result.title} — read by ${readerName}`
        : `Read by ${readerName}`;
    offerDownload(result.title);
    questionPanel.show(result.questions);
    warnIfLighter(result);
}

/** A lighter model misreads more, so its reading is worth checking by eye. */
function warnIfLighter(result) {
    if (!result.fallback) return;
    const why = result.fallback === "limit"
        ? "has hit its free-tier limit"
        : "was too busy";
    setStatus(
        `${readerName}'s usual model ${why}, so a lighter one read this, and it ` +
            "misreads more often. Check it against the page, or try again later.",
        "info",
    );
}

/** Sends my answers back, so the reader can correct the MusicXML. */
async function sendAnswers(answers) {
    if (!sourceFile) return;
    questionPanel.setBusy(true);
    setUploadsEnabled(false);
    const stopClock = showElapsed(`${readerName} is applying your answers`);
    try {
        const body = new FormData();
        body.append("file", sourceFile);
        body.append("instrument", ui.instrument.value);
        body.append("musicxml", currentMusicXml);
        body.append("answers", JSON.stringify(answers));

        const result = await post("api/refine", body);
        await showScore(result.musicxml, result.title);
        ui.pieceName.textContent = `${result.title} — corrected`;
        offerDownload(result.title);
        questionPanel.show(result.questions);
        warnIfLighter(result);
    } catch (error) {
        setStatus(`Could not apply the answers: ${error.message}`, "error");
    } finally {
        stopClock();
        questionPanel.setBusy(false);
        setUploadsEnabled(true);
    }
}

/**
 * Shows a busy message with a running clock. Reading a page takes a minute or
 * three, and a sentence that never changes for that long looks like a hang.
 * Returns the function that stops it.
 */
function showElapsed(message) {
    const started = Date.now();
    const tick = () => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        setStatus(`${message}… ${clock} — usually one to three minutes`, "busy");
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
}

function setUploadsEnabled(enabled) {
    ui.file.disabled = !enabled;
    for (const button of ui.samples) button.disabled = !enabled;
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

    // Once there is music on screen it is the point of the page, so the
    // loading controls fold away above it.
    ui.setupWrap.classList.remove("first-run");
    ui.setupWrap.open = false;
    ui.setupTitle.textContent = "Load something else";

    ui.controls.hidden = false;
    document.body.classList.add("has-transport");
    ui.piece.hidden = false;
    ui.pieceName.textContent = label;
    offerDownload(label);

    // The score is engraved to fit, so show the size that was actually used.
    if (view === score) showZoom(score.osmd.zoom);
    ui.zoomFit.hidden = true;

    const tempoNote = loadedTimeline.scoreBpm
        ? `score tempo ${loadedTimeline.scoreBpm} BPM`
        : "no tempo marking, defaulting to 100 BPM";
    const count = loadedTimeline.notes.length;
    const parts = [`${count} ${count === 1 ? "note" : "notes"}`, tempoNote];
    if (note) parts.push(note);
    setStatus(parts.join(" · "), "info");
}

function showZoom(factor) {
    const percent = Math.round((factor ?? 1) * 100);
    ui.zoom.value = percent;
    ui.zoomValue.textContent = `${percent}%`;
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
 * Offers the MusicXML on screen as a download. Worth having for a score that was
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
        // Before the first beat: counting in while playing, otherwise just idle
        // at the start of the piece.
        ui.position.textContent =
            player.state === "playing" ? "counting in" : timeline.isPianoRoll ? "0.0s" : "bar 1";
        return;
    }
    const bar = timeline.steps[step]?.measure;
    ui.position.textContent = bar ? `bar ${bar}` : `${Math.max(time, 0).toFixed(1)}s`;
}

function handleState(state) {
    editor.setPlaying(state === "playing");
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

// A handle for poking at the running app from the browser console, and for the
// checks in tools/browser-test.mjs.
window.sheetMusic = {
    player,
    editor,
    score,
    pianoRoll,
    get timeline() {
        return timeline;
    },
    loadSample,
};
