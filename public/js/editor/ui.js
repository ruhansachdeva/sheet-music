// Writing a score by hand, on a phone.
//
// Entering notation on a touch screen by aiming at a staff line is painful, so
// pitch comes from a piano keyboard you can actually hit with a thumb, and
// length from a palette of note values. Each tap appends to the score, which is
// re-engraved as you go.

import { DURATIONS, FLAT, KEY_SIGNATURES, SHARP, emptyScore, toMusicXml } from "./model.js";
import { KIT } from "../drums.js";

/** One octave of keys, drawn in keyboard order. */
const KEYS = [
    { name: "C", offset: 0 },
    { sharp: "C♯", flat: "D♭", offset: 1, usual: SHARP },
    { name: "D", offset: 2 },
    { sharp: "D♯", flat: "E♭", offset: 3, usual: FLAT },
    { name: "E", offset: 4 },
    { name: "F", offset: 5 },
    { sharp: "F♯", flat: "G♭", offset: 6, usual: SHARP },
    { name: "G", offset: 7 },
    { sharp: "G♯", flat: "A♭", offset: 8, usual: FLAT },
    { name: "A", offset: 9 },
    { sharp: "A♯", flat: "B♭", offset: 10, usual: FLAT },
    { name: "B", offset: 11 },
];

/**
 * How a black key is named, and so spelled, in this key: as flats in a flat
 * key, sharps in a sharp key, and the customary mix in C. The label on the key
 * is always the note that ends up on the staff.
 */
function spellingFor(key, fifths) {
    if (!key.sharp) return { name: key.name, prefer: SHARP };
    const prefer = fifths < 0 ? FLAT : fifths > 0 ? SHARP : key.usual;
    return { name: prefer === FLAT ? key.flat : key.sharp, prefer };
}

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
    constructor(container, { onChange, onClose, onPreview, onPreviewDrum }) {
        this.container = container;
        this.onChange = onChange;
        this.onClose = onClose;
        this.onPreview = onPreview;
        this.onPreviewDrum = onPreviewDrum;
        this.score = emptyScore();
        this.octave = 4;
        this.duration = "quarter";
        this.dotted = false;
        // Must start as a real boolean: classList.toggle(name, undefined)
        // toggles rather than forcing off, which drew Stack as switched on.
        this.stacking = false;
        this.history = [];
    }

    get isOpen() {
        return !this.container.hidden;
    }

    /** Switches between writing pitches and writing drums. */
    setKind(kind) {
        if (kind === this.score.kind) return;
        this.score = { ...emptyScore(kind), title: this.score.title, tempo: this.score.tempo,
            beats: this.score.beats, beatType: this.score.beatType };
        this.history = [];
        if (this.isOpen) {
            this.render();
            this.changed();
        }
    }

    open(score, kind = "pitched") {
        this.score = score ? structuredClone(score) : emptyScore(kind);
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

    addNote(midi, prefer = SHARP) {
        this.onPreview?.(midi);
        if (this.joinToLast("midis", midi, prefer)) return;

        this.remember();
        this.score.notes.push({
            midis: [midi],
            spell: { [midi]: prefer },
            duration: this.duration,
            dots: this.dotted ? 1 : 0,
        });
        this.changed();
    }

    /**
     * While stacking, a tap joins the note before it instead of following it,
     * which is what makes a chord. Returns whether it was taken.
     */
    joinToLast(field, value, prefer) {
        if (!this.stacking) return false;

        const last = this.score.notes.at(-1);
        if (!last || last.rest || !last[field]) return false;
        if (last[field].includes(value)) return true; // already in the chord

        this.remember();
        last[field] = [...last[field], value].sort((a, b) => a - b);
        if (prefer !== undefined) last.spell = { ...last.spell, [value]: prefer };
        this.changed();
        return true;
    }

    /** Adds a hit on one piece of the kit. */
    addDrum(gm) {
        this.onPreviewDrum?.(gm);
        if (this.joinToLast("drums", gm)) return;

        this.remember();
        this.score.notes.push({
            drums: [gm],
            duration: this.duration,
            dots: this.dotted ? 1 : 0,
        });
        this.changed();
    }

    addRest() {
        this.stacking = false;
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
            this.score.kind === "drums" ? this.renderKit() : this.renderKeyboard(),
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

        row.append(labelled("Time", time), labelled("Tempo", tempo));
        if (this.score.kind !== "drums") {
            const key = el("select");
            key.setAttribute("aria-label", "Key signature");
            for (const signature of KEY_SIGNATURES) {
                const option = el("option", null, `${signature.name} major`);
                option.value = String(signature.fifths);
                key.appendChild(option);
            }
            key.value = String(this.score.fifths);
            key.addEventListener("change", () => {
                this.score.fifths = Number(key.value);
                // The black keys rename themselves to suit the new key.
                this.render();
                this.changed();
            });
            row.append(labelled("Key", key), labelled("Clef", clef));
        }
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

        // Stacking is what turns a run of single notes into chords.
        const stack = el("button", "stack", "Stack");
        stack.title = "Add the next note to the one before it";
        stack.setAttribute("aria-pressed", String(Boolean(this.stacking)));
        stack.classList.toggle("chosen", Boolean(this.stacking));
        stack.addEventListener("click", () => {
            this.stacking = !this.stacking;
            this.render();
        });

        const rest = el("button", null, "Rest");
        rest.addEventListener("click", () => this.addRest());
        const undo = el("button", null, "Undo");
        undo.addEventListener("click", () => this.undo());
        const clear = el("button", null, "Clear");
        clear.addEventListener("click", () => this.clear());

        this.count = el("span", "editor-count");
        actions.append(stack, rest, undo, clear, this.count);

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
            const { name, prefer } = spellingFor(key, this.score.fifths);
            const button = el("button", `key ${key.sharp ? "black" : "white"}`);
            button.innerHTML = `<span>${name}</span>`;
            button.setAttribute("aria-label", `${name}${this.octave}`);
            button.addEventListener("click", () => this.addNote(midi, prefer));
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

    /** A pad per kit piece, instead of a keyboard. */
    renderKit() {
        const wrap = el("div", "editor-kit");
        for (const piece of KIT) {
            const pad = el("button", `pad${piece.cross ? " cymbal" : ""}`, piece.label);
            pad.addEventListener("click", () => this.addDrum(piece.gm));
            wrap.appendChild(pad);
        }
        return wrap;
    }

    refreshCount() {
        if (!this.count) return;

        const total = this.score.notes.length;
        const last = this.score.notes.at(-1);
        const stacked = (last?.midis ?? last?.drums ?? []).length;

        this.count.textContent =
            this.stacking && stacked > 1
                ? `${total} notes, last is ${stacked} together`
                : total === 1
                  ? "1 note"
                  : `${total} notes`;
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
