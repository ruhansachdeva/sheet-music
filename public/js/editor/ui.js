// Writing a score by hand, on a phone.
//
// Entering notation on a touch screen by aiming at a staff line is painful, so
// pitch comes from a piano keyboard you can actually hit with a thumb, and
// length from a palette of note values. Each tap appends to the score, which is
// re-engraved as you go.

import { DURATIONS, emptyScore, toMusicXml } from "./model.js";

/** One octave of keys, drawn in keyboard order. */
const KEYS = [
    { name: "C", offset: 0, black: false },
    { name: "C♯", offset: 1, black: true },
    { name: "D", offset: 2, black: false },
    { name: "E♭", offset: 3, black: true },
    { name: "E", offset: 4, black: false },
    { name: "F", offset: 5, black: false },
    { name: "F♯", offset: 6, black: true },
    { name: "G", offset: 7, black: false },
    { name: "A♭", offset: 8, black: true },
    { name: "A", offset: 9, black: false },
    { name: "B♭", offset: 10, black: true },
    { name: "B", offset: 11, black: false },
];

/**
 * The note values, drawn rather than typed: the Unicode musical symbols are
 * missing from most interface fonts and come out as empty boxes.
 */
const NOTE_SHAPES = {
    whole: '<ellipse cx="11" cy="17" rx="6.4" ry="4.4" fill="none" stroke="currentColor" stroke-width="2.2"/>',
    half: '<ellipse cx="9" cy="18" rx="5.4" ry="3.9" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M14.2 17V4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    quarter: '<ellipse cx="9" cy="18" rx="5.4" ry="3.9" fill="currentColor"/><path d="M14.2 17V4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    eighth: '<ellipse cx="9" cy="18" rx="5.4" ry="3.9" fill="currentColor"/><path d="M14.2 17V4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M14.2 4.6c3.6 1.6 5.2 3.6 4.4 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    "16th": '<ellipse cx="9" cy="18" rx="5.4" ry="3.9" fill="currentColor"/><path d="M14.2 17V4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M14.2 4.6c3.6 1.6 5.2 3.6 4.4 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M14.2 9.4c3.6 1.6 5.2 3.6 4.4 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};

function noteGlyph(name) {
    return `<svg viewBox="0 0 24 24" class="glyph" aria-hidden="true">${NOTE_SHAPES[name]}</svg>`;
}

const TIME_SIGNATURES = [
    [4, 4],
    [3, 4],
    [2, 4],
    [6, 8],
];

export class Editor {
    constructor(container, { onChange, onClose, onPreview }) {
        this.container = container;
        this.onChange = onChange;
        this.onClose = onClose;
        this.onPreview = onPreview;
        this.score = emptyScore();
        this.octave = 4;
        this.duration = "quarter";
        this.dotted = false;
        this.history = [];
    }

    get isOpen() {
        return !this.container.hidden;
    }

    open(score) {
        this.score = score ? structuredClone(score) : emptyScore();
        this.history = [];
        this.render();
        this.container.hidden = false;
        this.changed();
    }

    close() {
        this.container.hidden = true;
        this.onClose?.();
    }

    /** The score as MusicXML, for rendering, playing or saving. */
    toMusicXml() {
        return toMusicXml(this.score);
    }

    changed() {
        this.refreshCount();
        this.onChange?.(this.score);
    }

    // --- editing ---------------------------------------------------------

    remember() {
        this.history.push(structuredClone(this.score.notes));
        if (this.history.length > 50) this.history.shift();
    }

    addNote(midi) {
        this.onPreview?.(midi);
        this.remember();
        this.score.notes.push({
            midi,
            duration: this.duration,
            dots: this.dotted ? 1 : 0,
        });
        this.changed();
    }

    addRest() {
        this.remember();
        this.score.notes.push({
            rest: true,
            duration: this.duration,
            dots: this.dotted ? 1 : 0,
        });
        this.changed();
    }

    undo() {
        const previous = this.history.pop();
        if (!previous) return;
        this.score.notes = previous;
        this.changed();
    }

    clear() {
        this.remember();
        this.score.notes = [];
        this.changed();
    }

    // --- interface -------------------------------------------------------

    render() {
        this.container.innerHTML = "";
        this.container.append(
            this.renderHeader(),
            this.renderSettings(),
            this.renderPalette(),
            this.renderKeyboard(),
        );
    }

    renderHeader() {
        const header = el("div", "editor-head");

        const title = el("input", "editor-title");
        title.type = "text";
        title.value = this.score.title;
        title.setAttribute("aria-label", "Title");
        title.addEventListener("input", () => {
            this.score.title = title.value || "Untitled";
            this.onChange?.(this.score);
        });

        const done = el("button", "primary", "Done");
        done.addEventListener("click", () => this.close());

        header.append(title, done);
        return header;
    }

    renderSettings() {
        const row = el("div", "editor-settings");

        const time = el("select");
        time.setAttribute("aria-label", "Time signature");
        for (const [beats, beatType] of TIME_SIGNATURES) {
            const option = el("option", null, `${beats}/${beatType}`);
            option.value = `${beats}/${beatType}`;
            time.appendChild(option);
        }
        time.value = `${this.score.beats}/${this.score.beatType}`;
        time.addEventListener("change", () => {
            const [beats, beatType] = time.value.split("/").map(Number);
            this.score.beats = beats;
            this.score.beatType = beatType;
            this.changed();
        });

        const tempo = el("input", "editor-tempo");
        tempo.type = "number";
        tempo.min = "30";
        tempo.max = "240";
        tempo.value = String(this.score.tempo);
        tempo.setAttribute("aria-label", "Tempo in beats per minute");
        tempo.addEventListener("change", () => {
            this.score.tempo = Math.min(240, Math.max(30, Number(tempo.value) || 100));
            tempo.value = String(this.score.tempo);
            this.changed();
        });

        const clef = el("select");
        clef.setAttribute("aria-label", "Clef");
        for (const [value, label] of [["treble", "Treble"], ["bass", "Bass"]]) {
            const option = el("option", null, label);
            option.value = value;
            clef.appendChild(option);
        }
        clef.value = this.score.clef;
        clef.addEventListener("change", () => {
            this.score.clef = clef.value;
            // Bass clef means you are most likely writing low notes.
            this.octave = clef.value === "bass" ? 3 : 4;
            this.render();
            this.changed();
        });

        row.append(labelled("Time", time), labelled("Tempo", tempo), labelled("Clef", clef));
        return row;
    }

    renderPalette() {
        const palette = el("div", "editor-palette");

        const lengths = el("div", "lengths");
        for (const duration of DURATIONS) {
            const button = el("button", "length");
            button.innerHTML = noteGlyph(duration.name);
            button.title = duration.label;
            button.setAttribute("aria-label", duration.label);
            button.classList.toggle("chosen", duration.name === this.duration);
            button.addEventListener("click", () => {
                this.duration = duration.name;
                this.render();
            });
            lengths.appendChild(button);
        }

        const dot = el("button", "length dot");
        dot.innerHTML =
            '<svg viewBox="0 0 24 24" class="glyph" aria-hidden="true">' +
            '<circle cx="12" cy="12" r="3.4" fill="currentColor"/></svg>';
        dot.setAttribute("aria-label", "Dotted");
        dot.setAttribute("aria-pressed", String(this.dotted));
        dot.classList.toggle("chosen", this.dotted);
        dot.addEventListener("click", () => {
            this.dotted = !this.dotted;
            this.render();
        });
        lengths.appendChild(dot);

        const actions = el("div", "editor-actions");
        const rest = el("button", null, "Rest");
        rest.addEventListener("click", () => this.addRest());
        const undo = el("button", null, "Undo");
        undo.addEventListener("click", () => this.undo());
        const clear = el("button", null, "Clear");
        clear.addEventListener("click", () => this.clear());

        this.count = el("span", "editor-count");
        actions.append(rest, undo, clear, this.count);

        palette.append(lengths, actions);
        return palette;
    }

    renderKeyboard() {
        const wrap = el("div", "editor-keys");

        const down = el("button", "octave", "−");
        down.setAttribute("aria-label", "Octave down");
        down.addEventListener("click", () => {
            this.octave = Math.max(1, this.octave - 1);
            this.render();
        });

        const keyboard = el("div", "keyboard");
        for (const key of KEYS) {
            const midi = (this.octave + 1) * 12 + key.offset;
            const button = el("button", `key ${key.black ? "black" : "white"}`);
            button.innerHTML = `<span>${key.name}</span>`;
            button.setAttribute("aria-label", `${key.name}${this.octave}`);
            button.addEventListener("click", () => this.addNote(midi));
            keyboard.appendChild(button);
        }

        const up = el("button", "octave", "+");
        up.setAttribute("aria-label", "Octave up");
        up.addEventListener("click", () => {
            this.octave = Math.min(7, this.octave + 1);
            this.render();
        });

        const label = el("span", "octave-label", `Octave ${this.octave}`);
        wrap.append(keyboard, el("div", "octave-row", "", [down, label, up]));
        return wrap;
    }

    refreshCount() {
        if (!this.count) return;
        const total = this.score.notes.length;
        this.count.textContent = total === 1 ? "1 note" : `${total} notes`;
    }
}

function el(tag, className, text, children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    if (children) node.append(...children);
    return node;
}

function labelled(text, control) {
    const wrap = el("label", "editor-field");
    wrap.append(el("span", "label", text), control);
    return wrap;
}
