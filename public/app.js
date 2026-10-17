// Front end controller: picks a loader for the uploaded file, wires the
// transport controls to the player, and drives the highlighting.

import { INSTRUMENTS, DEFAULT_INSTRUMENT } from "./js/instruments.js";
import { Score } from "./js/score.js";
import { PianoRoll } from "./js/midi.js";
import { Player } from "./js/player.js";
import { QuestionPanel } from "./js/questions.js";
import { Editor } from "./js/editor/ui.js";
import { isSvg, preparePhoto, stripsOf } from "./js/photo.js";
import { keepScreenOn } from "./js/wake.js";
import * as ownKey from "./js/reader/browser.js";
import { guessInstrument } from "./js/instrument-guess.js";

const ui = {
    file: document.getElementById("file"),
    chooseFile: document.getElementById("choose-file"),
    takePhoto: document.getElementById("take-photo"),
    camera: document.getElementById("camera"),
    pagesTaken: document.getElementById("pages-taken"),
    pagesThumbs: document.getElementById("pages-thumbs"),
    pagesCount: document.getElementById("pages-count"),
    readPages: document.getElementById("read-pages"),
    addPage: document.getElementById("add-page"),
    clearPages: document.getElementById("clear-pages"),
    rereadBar: document.getElementById("reread-bar"),
    rereadShaded: document.getElementById("reread-shaded"),
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
    seek: document.getElementById("seek"),
    timeNow: document.getElementById("time-now"),
    timeTotal: document.getElementById("time-total"),
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
    instrumentCheck: document.getElementById("instrument-check"),
    instrumentCheckText: document.getElementById("instrument-check-text"),
    instrumentSwitch: document.getElementById("instrument-switch"),
    instrumentKeep: document.getElementById("instrument-keep"),
    noReaderText: document.getElementById("no-reader-text"),
    keyForm: document.getElementById("key-form"),
    keyInput: document.getElementById("key-input"),
    keyError: document.getElementById("key-error"),
    ownKey: document.getElementById("own-key"),
    forgetKey: document.getElementById("forget-key"),
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
        // user still needs to read - or the clock of a read in progress.
        if (statusKind === "error" || reading) return;

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

// The same for the transport bar, which grows when More is open.
new ResizeObserver(() => {
    document.documentElement.style.setProperty("--transport-height", `${ui.controls.offsetHeight}px`);
}).observe(ui.controls);

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
    forgetSource();
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
/** True while a read is running: its clock owns the status line. */
let reading = false;
let lastInfo = "";

/** The photo or PDF behind the current score, kept so answers can be applied to it. */
let sourceFile = null;

/** The score on screen is no longer a reading of a page. */
function forgetSource() {
    sourceFile = null;
    ui.rereadBar.hidden = true;
    ui.rereadShaded.hidden = true;
}

// The bar the player is on, for "Re-read bar N".
let currentBar = 1;
// The same page cut into strips between its systems, if it would cut.
let sourceStrips = [];

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

/**
 * True when photos are read here in the page, with a key saved in this
 * browser, rather than by a server.
 */
let readsHere = false;

/** What the page says when nothing can read photos, by whether a server is there. */
let noReaderText = "";

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
        // The hosted build answers from a static file that says it is one.
        if (health.static) served = false;
    } catch {
        served = false;
        canRead = false;
    }
    if (canRead) return;

    noReaderText = served
        ? "No API key is set in .env, so the server cannot read photos and PDFs. Add one " +
          "there and restart, or read them here in the browser instead."
        : "This is the hosted copy, so there is no server to read photos and PDFs with. " +
          "Playing and writing music works without one.";

    // A key saved here earlier: read in the page, no server needed.
    if (ownKey.savedKey()) readHere();
    else cannotRead();
}

/** Photos and PDFs are read in this page, with the saved key. */
function readHere() {
    readsHere = true;
    canRead = true;
    readerName = "Gemini";
    ui.noReader.hidden = true;
    ui.ownKey.hidden = false;
    ui.takePhoto.hidden = !hasCamera();
    ui.file.accept = ".musicxml,.xml,.mxl,.mid,.midi,image/*,application/pdf";
}

/** Nothing can read photos: say so, and offer a key. */
function cannotRead() {
    readsHere = false;
    canRead = false;
    ui.noReaderText.textContent = noReaderText;
    ui.noReader.hidden = false;
    ui.ownKey.hidden = true;
    ui.takePhoto.hidden = true;
    // Leave the file picker, but stop it offering what it cannot do.
    ui.file.accept = ".musicxml,.xml,.mxl,.mid,.midi";
}

ui.keyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = ui.keyInput.value.trim();
    if (!key) return;

    const save = ui.keyForm.querySelector("button");
    save.disabled = true;
    ui.keyError.hidden = true;
    const problem = await ownKey.checkKey(key)
        ?? (ownKey.saveKey(key) ? null : "This browser would not save the key - private browsing, perhaps.");
    save.disabled = false;

    if (problem) {
        ui.keyError.textContent = problem;
        ui.keyError.hidden = false;
        return;
    }
    ui.keyInput.value = "";
    readHere();
    setStatus("Key saved. Photos and PDFs are read right here now.", "info");
});

ui.forgetKey.addEventListener("click", () => {
    ownKey.forgetKey();
    cannotRead();
    setStatus("The key is gone from this browser.", "info");
});

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
    // Writing drums is a different kind of notation, so an open writer
    // follows, to that kind's own draft. A closed one is left alone: it opens
    // on the right kind's draft, and Edit opens what is on screen.
    if (editor.isOpen) editor.setKind(writingKind(), loadDraft(writingKind()));
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

// Tapping a note pauses the music and moves to that note, so Play carries on
// from it. On the score you wrote, with the writer open, the tap also selects
// the note for editing, as tapping its chip does; tapping past the last note
// goes back to adding at the end.
ui.score.addEventListener("click", (event) => {
    if (view !== score || !timeline) return;
    const whole = score.noteAt(event.clientX, event.clientY);
    if (whole === null) return;

    const step = stepFor(whole);
    if (step) {
        player.pause();
        player.seek(step.time);
    }

    if (!writtenOnScreen || !editor.isOpen) return;
    const index = editor.indexAt(whole);
    if (index === null) {
        if (editor.selected !== null) editor.select(editor.selected);
    } else if (index !== editor.selected) {
        editor.select(index);
    }
});

/**
 * The cursor step for a place in the score, in whole notes. A note inside a
 * repeat is played more than once; the pass nearest where playback is now is
 * the one meant.
 */
function stepFor(whole) {
    const here = Math.max(player.position(), 0);
    let best = null;
    for (const step of timeline.steps) {
        if (Math.abs(step.at - whole) > 1e-6) continue;
        if (!best || Math.abs(step.time - here) < Math.abs(best.time - here)) best = step;
    }
    return best;
}

// Browsers keep audio suspended until the page has been interacted with, so
// take the first touch as the cue rather than waiting for a note to be played.
for (const event of ["pointerdown", "keydown"]) {
    window.addEventListener(event, () => player.warmUp().catch(() => {}), { once: true });
}
ui.takePhoto.addEventListener("click", () => ui.camera.click());

// Photos from the camera wait in a tray rather than being read straight
// away, so a piece can be photographed page by page and read as one score.
const pagesTaken = [];

function showPagesTaken() {
    for (const thumb of ui.pagesThumbs.querySelectorAll("img")) URL.revokeObjectURL(thumb.src);
    ui.pagesThumbs.replaceChildren(...pagesTaken.map((photo, i) => {
        const thumb = document.createElement("img");
        thumb.src = URL.createObjectURL(photo);
        thumb.alt = `Page ${i + 1}`;
        return thumb;
    }));
    const count = pagesTaken.length;
    ui.pagesCount.textContent = count === 1
        ? "1 page. Add the next page of the piece, or read it."
        : `${count} pages, read together as one score.`;
    ui.readPages.textContent = count === 1 ? "Read it" : `Read ${count} pages`;
    ui.addPage.disabled = count >= MAX_PAGES;
    ui.pagesTaken.hidden = count === 0;
}

ui.camera.addEventListener("change", () => {
    const photo = ui.camera.files?.[0];
    ui.camera.value = "";
    if (!photo) return;
    pagesTaken.push(photo);
    showPagesTaken();
});

ui.addPage.addEventListener("click", () => ui.camera.click());

ui.readPages.addEventListener("click", () => {
    const pages = pagesTaken.splice(0);
    showPagesTaken();
    loadFiles(pages, { inOrder: true });
});

ui.clearPages.addEventListener("click", () => {
    pagesTaken.length = 0;
    showPagesTaken();
});

// Only offer the camera where there is one: a desktop browser ignores the
// capture attribute, so the button would just reopen the file dialog.
function hasCamera() {
    return Boolean(window.matchMedia?.("(pointer: coarse)").matches && navigator.mediaDevices?.getUserMedia);
}
if (hasCamera()) {
    ui.takePhoto.hidden = false;
    ui.chooseFile.classList.remove("primary");
}

ui.file.addEventListener("change", () => {
    const files = [...(ui.file.files ?? [])];
    if (!files.length) return;
    loadFiles(files);
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
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    document.body.classList.remove("dropping");
    loadFiles(files);
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
    ui.tempoValue.textContent = `${formatBpm(bpm)} BPM`;
    player.setTempo(bpm);
    ui.tempoReset.hidden = !timeline || bpm === timeline.bpm;
    showTime();
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

// Whether whatever has focus got it from a click or a tap, rather than from
// the keyboard. (:focus-visible cannot tell: the browser switches it on for
// the focused button the moment any key goes down, Space included.)
let pointerIsDown = false;
let focusFromPointer = false;
document.addEventListener("pointerdown", () => (pointerIsDown = true), true);
document.addEventListener("pointerup", () => setTimeout(() => (pointerIsDown = false)), true);
document.addEventListener("focusin", () => (focusFromPointer = pointerIsDown), true);

document.addEventListener("keydown", (event) => {
    if (event.target instanceof Element && event.target.matches("input, select, textarea")) return;

    // Space presses a button reached with the keyboard, as it should for a
    // keyboard user. A button just clicked keeps focus too, and there Space
    // still plays, rather than writing the clicked piano key a second time.
    if (
        event.code === "Space" &&
        !focusFromPointer &&
        event.target instanceof Element &&
        event.target.matches("button, summary, a[href], [role=button], [role=option]")
    ) {
        return;
    }

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

/** The most pages read together: each is several images in the request. */
const MAX_PAGES = 12;

/** A file that is a page to be read: a photo, a scan, an SVG or a PDF. */
function isPage(file) {
    return file.type.startsWith("image/") || file.type === "application/pdf" || isSvg(file);
}

/**
 * Several files at once are the pages of one piece - photos of each page, say
 * - and are read together, in name order (IMG_0001 before IMG_0002), into one
 * score. One file loads as itself.
 */
async function loadFiles(files, { inOrder = false } = {}) {
    if (files.length === 1) return loadFile(files[0]);
    player.stop();
    if (!files.every(isPage)) {
        setStatus("Several files can be read together when they are all photos or PDFs - the pages of one piece. Open other files one at a time.", "error");
        return;
    }
    if (files.length > MAX_PAGES) {
        setStatus(`That is ${files.length} pages; up to ${MAX_PAGES} can be read together.`, "error");
        return;
    }
    if (!canRead) {
        setStatus(`${noReaderText} Save a Gemini key above to read these pages here.`, "error");
        return;
    }
    // Photos taken one after another come in the order they were taken, and
    // a phone may give them all the same name.
    const pages = inOrder ? [...files]
        : [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    try {
        await transcribe(pages);
    } catch (error) {
        console.error(error);
        setStatus(`Could not read those pages: ${error.message}`, "error");
    }
}

async function loadFile(file) {
    const name = file.name.toLowerCase();
    player.stop();

    try {
        if (name.endsWith(".mxl")) {
            forgetSource();
            questionPanel.hide();
            // Unzipped to text here rather than by OSMD, so a .mxl file has
            // MusicXML to download and a tempo map like any other score.
            await showScore(await opensheetmusicdisplay.MXLHelper.MXLtoXMLstring(file), file.name);
        } else if (name.endsWith(".musicxml") || name.endsWith(".xml")) {
            forgetSource();
            questionPanel.hide();
            await showScore(await file.text(), file.name);
        } else if (name.endsWith(".mid") || name.endsWith(".midi")) {
            await showPianoRoll(await file.arrayBuffer(), file.name);
        } else if (file.type.startsWith("image/") || file.type === "application/pdf" || isSvg(file)) {
            if (!canRead) {
                setStatus(`${noReaderText} Save a Gemini key above to read ${file.name} here.`, "error");
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
    forgetSource();
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
 * `instrument` is what a reader said the page is written for, if it said, and
 * `ask: false` skips asking about it - for a correction of a page already asked about.
 */
async function showScore(content, label, { written = false, instrument = null, ask = true } = {}) {
    setStatus("Rendering the score…", "busy");
    ui.instrumentCheck.hidden = true;
    if (written) writtenOnScreen = true;
    else showingSomethingElse();
    ui.score.classList.toggle("tappable", writtenOnScreen);
    if (typeof content === "string") currentMusicXml = content;

    ui.roll.hidden = true;
    pianoRoll.clear();
    ui.score.hidden = false;

    timeline = await score.load(content);
    view = score;
    ready(score.title || label, timeline, transposeNote(timeline.transposedBy));

    // What you write is for the instrument you chose; anything else might not be.
    if (!written && ask) {
        const parts = score.osmd.Sheet.Instruments.flatMap((part) => [
            part.Name,
            ...(part.SubInstruments ?? []).map((sub) => sub.name),
        ]);
        askAboutInstrument(instrument && instrument !== "unknown"
            ? instrument
            : guessInstrument({ names: parts, drumShare: drumShare(timeline) }));
    }
}

function drumShare(loaded) {
    const notes = loaded.notes.length;
    return notes ? loaded.notes.filter((note) => note.drumKey !== null).length / notes : 0;
}

/**
 * Asks, when a piece looks written for another instrument than the one
 * picked - drum music with Flute picked, say - which it should play as. The
 * pick sets the sound and the transposition, so a wrong one is worth a word.
 */
let suggestedInstrument = null;
function askAboutInstrument(guess) {
    const picked = ui.instrument.value;
    if (!guess || guess === picked || !INSTRUMENTS[guess]) return;

    suggestedInstrument = guess;
    const name = (key) => INSTRUMENTS[key].label;
    ui.instrumentCheckText.textContent = guess === "drums"
        ? `This looks like drum music, but ${name(picked)} is picked.`
        : `This looks written for ${name(guess)}, but ${name(picked)} is picked.`;
    ui.instrumentSwitch.textContent = `Play it as ${name(guess)}`;
    ui.instrumentKeep.textContent = `Keep ${name(picked)}`;
    ui.instrumentCheck.hidden = false;
}

ui.instrumentSwitch.addEventListener("click", () => {
    ui.instrumentCheck.hidden = true;
    ui.instrument.value = suggestedInstrument;
    // The picker's own handler loads the sound and remembers the choice.
    ui.instrument.dispatchEvent(new Event("change"));
});

ui.instrumentKeep.addEventListener("click", () => {
    ui.instrumentCheck.hidden = true;
});

/**
 * Anything newly put on screen is not the written score until shown to be,
 * so Edit goes - it would otherwise reopen the old written score over it.
 */
function showingSomethingElse() {
    writtenOnScreen = false;
    ui.editScore.hidden = true;
    ui.instrumentCheck.hidden = true;
}

/** What the status line says about a score that sets its own transposition. */
function transposeNote(semitones) {
    if (!semitones) return null;
    const amount = Math.abs(semitones);
    const size = amount === 12 ? "an octave" : `${amount} semitone${amount === 1 ? "" : "s"}`;
    return `the score sounds ${size} ${semitones < 0 ? "lower" : "higher"} than written, ` +
        "and plays that way whatever instrument is picked";
}

async function showPianoRoll(arrayBuffer, label) {
    setStatus("Reading the MIDI file…", "busy");
    showingSomethingElse();
    forgetSource();
    questionPanel.hide();

    ui.score.hidden = true;
    score.clear();
    ui.roll.hidden = false;

    timeline = await pianoRoll.load(arrayBuffer);
    view = pianoRoll;
    ready(pianoRoll.title || label, timeline, "MIDI is already at concert pitch, so it plays untransposed.");
    askAboutInstrument(guessInstrument({ names: timeline.instrumentNames, drumShare: drumShare(timeline) }));
}

/**
 * A photo or a PDF - or several, the pages of one piece - is read into
 * MusicXML, then rendered like any score.
 */
async function transcribe(originals) {
    const pages = [originals].flat();
    questionPanel.hide();
    setStatus(
        pages.length > 1 ? `Preparing ${pages.length} pages…`
            : pages[0].type === "application/pdf" ? "Preparing the pages…" : "Preparing the photo…",
        "busy",
    );
    const prepared = [];
    for (const page of pages) prepared.push(await preparePhoto(page));
    const file = prepared[0];
    // Every page in strips, in order; a page that will not cut goes whole.
    let strips = [];
    if (prepared.length === 1) {
        strips = await stripsOf(file);
    } else {
        for (const page of prepared) {
            const cut = await stripsOf(page);
            strips.push(...(cut.length ? cut : [page]));
        }
    }

    const body = new FormData();
    body.append("file", file);
    for (const strip of strips) body.append("strips", strip);
    body.append("instrument", ui.instrument.value);

    // One read at a time: a second upload mid-request would race the first.
    setUploadsEnabled(false);
    const stopClock = showElapsed(`Reading your sheet music with ${readerName}`, howLong(strips));
    let result;
    try {
        result = readsHere
            ? await ownKey.transcribe({ file, strips, instrument: ui.instrument.value, onProgress: stopClock.progress })
            : await post("api/transcribe", body);
    } finally {
        stopClock();
        setUploadsEnabled(true);
    }
    await showScore(result.musicxml, result.title, { instrument: result.instrument });
    sourceFile = file;
    sourceStrips = strips;
    currentBar = 1;
    ui.rereadBar.textContent = "Re-read bar 1";
    ui.rereadBar.hidden = false;
    shade(result.uneven);
    ui.pieceName.textContent = result.title
        ? `${result.title} — read by ${readerName}`
        : `Read by ${readerName}`;
    offerDownload(result.title);
    questionPanel.show(result.questions);
    warnAboutReading(result);
}

/**
 * What is worth checking by eye in a reading: anything a lighter model read,
 * since it misreads more, and any bar still not adding up after the recheck,
 * since its rhythm is certainly off.
 */
function warnAboutReading(result) {
    const warnings = [];
    if (result.fallback) {
        const why = result.fallback === "limit"
            ? "has hit its free-tier limit"
            : "was too busy";
        warnings.push(
            `${readerName}'s usual model ${why}, so a lighter one read this, and it ` +
                "misreads more often. Check it against the page, or try again later.",
        );
    }
    const bars = result.uneven ?? [];
    if (bars.length) {
        const one = bars.length === 1;
        const list = bars.length > 6 ? `${bars.slice(0, 5).join(", ")} and ${bars.length - 5} more` : bars.join(", ");
        warnings.push(
            `${one ? "Bar" : "Bars"} ${list} ${one ? "does" : "do"} not add up to the time signature, ` +
                `so ${one ? "its" : "their"} rhythm is off - ${one ? "it is" : "they are"} shaded on the score. ` +
                `Check ${one ? "it" : "them"} against the page.`,
        );
    }
    const gone = result.missing ?? [];
    if (gone.length) {
        const list = gone.length > 6 ? `${gone.slice(0, 5).join(", ")} and ${gone.length - 5} more` : gone.join(", ");
        warnings.push(
            `${gone.length === 1 ? "Bar" : "Bars"} ${list} could not be read, so ${gone.length === 1 ? "it is" : "they are"} ` +
                "missing. Try again, or read that part of the page on its own.",
        );
    }
    if (warnings.length) setStatus(warnings.join(" "), "info");
}

/** Bars of a reading still wrong: shaded on the score, and offered to re-read. */
let shadedBars = [];

function shade(bars) {
    shadedBars = (bars ?? []).map(Number).filter(Number.isFinite);
    score.markBars(shadedBars);
    const count = shadedBars.length;
    ui.rereadShaded.textContent = `Re-read ${count === 1 ? "the shaded bar" : `${count} shaded bars`}`;
    ui.rereadShaded.hidden = !(sourceFile && count);
}

/** "bar 5", "bars 5 and 6", "bars 5, 6 and 9". */
function barsText(bars) {
    if (bars.length === 1) return `bar ${bars[0]}`;
    return `bars ${bars.slice(0, -1).join(", ")} and ${bars.at(-1)}`;
}

/**
 * Reads bars again - the one the player is on (tap a wrong note to go to its
 * bar), or every shaded one. A bar can add up and still be wrong, which only
 * listening catches; this looks again at just those bars, in one request,
 * and keeps the rest.
 */
async function rereadBars(bars) {
    if (!sourceFile || !currentMusicXml || !bars.length) return;
    const which = barsText(bars);
    player.pause();
    const name = ui.pieceName.textContent;
    setUploadsEnabled(false);
    ui.rereadBar.disabled = true;
    ui.rereadShaded.disabled = true;
    const stopClock = showElapsed(`${readerName} is reading ${which} again`, "usually a minute or two");
    let result;
    try {
        const body = new FormData();
        body.append("file", sourceFile);
        for (const strip of sourceStrips) body.append("strips", strip);
        body.append("instrument", ui.instrument.value);
        body.append("musicxml", currentMusicXml);
        body.append("bars", JSON.stringify(bars));
        result = readsHere
            ? await ownKey.reread({
                  file: sourceFile,
                  strips: sourceStrips,
                  instrument: ui.instrument.value,
                  musicxml: currentMusicXml,
                  bars,
                  onProgress: stopClock.progress,
              })
            : await post("api/reread", body);
    } catch (error) {
        setStatus(`Could not read ${which} again: ${error.message}`, "error");
        return;
    } finally {
        stopClock();
        setUploadsEnabled(true);
        ui.rereadBar.disabled = false;
        ui.rereadShaded.disabled = false;
    }

    if (!result.changed.length) {
        setStatus(`${readerName} read ${which} the same way again. If it is still wrong, Edit notes can fix it by hand.`, "info");
        return;
    }
    await showScore(result.musicxml, name, { ask: false });
    ui.pieceName.textContent = name;
    offerDownload(name.replace(/ — .*$/, ""));
    shade(result.uneven);
    // Back to the first bar that changed, so it can be heard straight away.
    const first = Math.min(...result.changed.map(Number));
    const step = timeline.steps.find((s) => s.measure === first);
    if (step) player.seek(step.time);
    const fixed = barsText(result.changed.map(Number).sort((a, b) => a - b));
    setStatus(`${fixed[0].toUpperCase()}${fixed.slice(1)} read again and corrected. Press play to hear ${result.changed.length === 1 ? "it" : "them"}.`, "info");
}

ui.rereadBar.addEventListener("click", () => rereadBars([currentBar]));
ui.rereadShaded.addEventListener("click", () => rereadBars(shadedBars));

/** Sends my answers back, so the reader can correct the MusicXML. */
async function sendAnswers(answers) {
    if (!sourceFile) return;
    questionPanel.setBusy(true);
    setUploadsEnabled(false);
    const stopClock = showElapsed(`${readerName} is applying your answers`, howLong(sourceStrips));
    try {
        const body = new FormData();
        body.append("file", sourceFile);
        for (const strip of sourceStrips) body.append("strips", strip);
        body.append("instrument", ui.instrument.value);
        body.append("musicxml", currentMusicXml);
        body.append("answers", JSON.stringify(answers));

        const result = readsHere
            ? await ownKey.refine({
                  file: sourceFile,
                  strips: sourceStrips,
                  instrument: ui.instrument.value,
                  musicxml: currentMusicXml,
                  answers,
                  onProgress: stopClock.progress,
              })
            : await post("api/refine", body);
        await showScore(result.musicxml, result.title, { ask: false });
        shade(result.uneven);
        ui.pieceName.textContent = `${result.title} — corrected`;
        offerDownload(result.title);
        questionPanel.show(result.questions);
        warnAboutReading(result);
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
/**
 * What to expect, until the reader says what it is doing. A page cut into
 * several strips is a dense one, and takes longer: about seven minutes in
 * real reads of a page of sixteenth-note drums.
 */
function howLong(strips) {
    return strips.length > 2 ? "a dense page takes five to ten minutes" : "usually one to four minutes";
}

function showElapsed(message, estimate = "usually one to four minutes") {
    reading = true;
    // A locked screen would suspend the page and drop the reading.
    const letScreenSleep = keepScreenOn();
    const started = Date.now();
    let detail = estimate;
    const tick = () => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        setStatus(`${message}… ${clock} — ${detail}`, "busy");
    };
    tick();
    const timer = setInterval(tick, 1000);
    const stop = () => {
        clearInterval(timer);
        letScreenSleep();
        reading = false;
    };
    // What the reader says it is working on, in place of the estimate - only
    // a read in the page hears this, as the model's thinking streams in.
    stop.progress = (heading) => {
        detail = heading;
        tick();
    };
    return stop;
}

function setUploadsEnabled(enabled) {
    // The visible buttons too, not only the inputs behind them: a live-looking
    // button that does nothing when tapped is worse than a disabled one.
    for (const control of [ui.file, ui.camera, ui.chooseFile, ui.takePhoto, ui.readPages, ui.addPage, ...ui.samples]) {
        control.disabled = !enabled;
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
    ui.seek.max = String(loadedTimeline.duration);
    ui.seek.value = "0";
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
        ? `score tempo ${formatBpm(loadedTimeline.scoreBpm)} BPM`
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
    ui.tempo.min = Math.min(30, Math.floor(bpm));
    ui.tempo.max = Math.max(240, Math.ceil(bpm));
    // The slider moves in whole steps, but the player gets the exact tempo:
    // "eighth = 125" is 62.5 quarter notes a minute, not 63.
    ui.tempo.value = bpm;
    ui.tempoValue.textContent = `${formatBpm(bpm)} BPM`;
    player.setTempo(bpm);
    showTime(0);
    ui.tempoReset.hidden = true;
    ui.tempoReset.textContent = loadedTimeline.scoreBpm
        ? `Reset to score tempo (${formatBpm(loadedTimeline.scoreBpm)} BPM)`
        : "Reset to 100 BPM";
}

/** 120 as "120", 62.5 as "62.5": tempos to a tenth at most. */
function formatBpm(bpm) {
    return String(Math.round(bpm * 10) / 10);
}

// --- playback feedback ------------------------------------------------------

function handlePosition(time, step) {
    if (view === score) score.showStep(step);
    else if (view === pianoRoll) pianoRoll.showTime(time);
    showPosition(time, step);
    showTime(time);
}

/**
 * The seek bar's clock: time played and the whole length, in real seconds at
 * the tempo chosen - so slowing the tempo makes the piece longer, as it is.
 */
function showTime(time = player.position()) {
    if (!timeline) return;
    const at = Math.min(Math.max(time, 0), timeline.duration);
    const real = (seconds) => (seconds * timeline.bpm) / player.tempo;
    const clock = (seconds) => {
        const whole = Math.round(real(seconds));
        return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
    };
    ui.seek.value = String(at);
    ui.timeNow.textContent = clock(at);
    ui.timeTotal.textContent = clock(timeline.duration);
    ui.seek.setAttribute("aria-valuetext", `${clock(at)} of ${clock(timeline.duration)}`);
}

// Sliding the seek bar moves through the piece, the highlighted notes with
// it. Grabbing it while the music plays pauses until it is let go, so the
// slide is silent and playing carries on from wherever it lands.
let resumeAfterSlide = false;
ui.seek.addEventListener("pointerdown", () => {
    if (player.state !== "playing") return;
    resumeAfterSlide = true;
    player.pause();
});
ui.seek.addEventListener("input", () => player.seek(Number(ui.seek.value)));
const letGo = () => {
    if (!resumeAfterSlide) return;
    resumeAfterSlide = false;
    player.seek(Number(ui.seek.value));
    Promise.resolve(player.play()).catch(reportError);
};
ui.seek.addEventListener("change", letGo);
ui.seek.addEventListener("pointerup", letGo);
ui.seek.addEventListener("pointercancel", letGo);

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
    if (bar && bar !== currentBar) {
        currentBar = bar;
        ui.rereadBar.textContent = `Re-read bar ${bar}`;
    }
}

function handleState(state) {
    editor.setPlaying(state === "playing");
    ui.play.textContent = state === "playing" ? "Pause" : "Play";
    ui.play.classList.toggle("playing", state === "playing");
    if (state === "stopped") {
        view?.reset();
        if (timeline) ui.position.textContent = timeline.isPianoRoll ? "0.0s" : "bar 1";
        showTime(0);
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
