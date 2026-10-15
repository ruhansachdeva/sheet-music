// MIDI files carry no notation, so they get a piano roll instead of a score.
// The timeline shape is the same one score.js produces, so the player does not
// care which kind of file is loaded.

import { Midi } from "https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/+esm";

const MIDI_DEFAULT_BPM = 120;

/**
 * Roll geometry, in the SVG's own units. The SVG is stretched to fit, so the
 * octave labels are HTML beside it rather than SVG text, which would be
 * stretched - squashed to a few pixels on a phone.
 */
const WIDTH = 1000;
const ROW = 8;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEYS = [1, 3, 6, 8, 10];

export class PianoRoll {
    constructor(container) {
        this.container = container;
        this.noteElements = [];
        this.lit = new Set();
        this.playhead = null;
        this.duration = 0;
    }

    /** Parses the file and draws the roll. Returns the timeline. */
    async load(arrayBuffer) {
        const midi = new Midi(arrayBuffer);
        const timeline = buildTimeline(midi);
        this.title = midi.name || "";
        this.draw(timeline);
        return timeline;
    }

    draw(timeline) {
        this.container.innerHTML = "";
        this.noteElements = [];
        this.lit.clear();
        this.duration = timeline.duration || 1;

        const pitches = timeline.notes.map((n) => n.midi);
        const low = Math.min(...pitches, 60) - 2;
        const high = Math.max(...pitches, 72) + 2;
        const rows = Math.max(high - low + 1, 12);

        this.high = high;
        const height = rows * ROW;

        const frame = document.createElement("div");
        frame.className = "roll-frame";
        const labels = document.createElement("div");
        labels.className = "roll-labels";
        labels.setAttribute("aria-hidden", "true");

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "piano-roll");
        svg.setAttribute("viewBox", `0 0 ${WIDTH} ${height}`);
        svg.setAttribute("preserveAspectRatio", "none");

        const add = (name, attributes, text) => {
            const element = document.createElementNS("http://www.w3.org/2000/svg", name);
            for (const [key, value] of Object.entries(attributes)) {
                element.setAttribute(key, value);
            }
            if (text !== undefined) element.textContent = text;
            svg.appendChild(element);
            return element;
        };

        for (let midi = low; midi <= high; midi++) {
            const pitchClass = ((midi % 12) + 12) % 12;
            const y = (high - midi) * ROW;

            // A faint stripe behind every black key, so the pitches stay readable.
            if (BLACK_KEYS.includes(pitchClass)) {
                add("rect", { x: 0, y, width: WIDTH, height: ROW, class: "roll-row" });
            }
            // Label each C, and draw its line, so the pitches can be read off.
            if (pitchClass === 0) {
                add("line", { x1: 0, x2: WIDTH, y1: y + ROW, y2: y + ROW, class: "roll-octave" });
                const label = document.createElement("span");
                label.className = "roll-label";
                // Centred on the C's row, as a share of the roll's height.
                label.style.top = `${((y + ROW / 2) / height) * 100}%`;
                label.textContent = `${NOTE_NAMES[pitchClass]}${Math.floor(midi / 12) - 1}`;
                labels.appendChild(label);
            }
        }

        // A bar line per metronome accent gives the roll a sense of metre.
        for (const beat of timeline.beats) {
            if (!beat.accent) continue;
            const x = this.xFor(beat.time);
            add("line", { x1: x, x2: x, y1: 0, y2: height, class: "roll-bar" });
        }

        for (const note of timeline.notes) {
            const x = this.xFor(note.time);
            const rect = add("rect", {
                x,
                y: (high - note.midi) * ROW + 1,
                width: Math.max(this.xFor(note.time + note.duration) - x, 1.5),
                height: ROW - 2,
                rx: 1.5,
                class: note.drumKey !== null ? "roll-note drum" : "roll-note",
            });
            this.noteElements.push({ element: rect, note });
        }

        this.playhead = add("line", { x1: 0, x2: 0, y1: 0, y2: height, class: "roll-playhead" });

        frame.append(labels, svg);
        this.container.appendChild(frame);
    }

    /** Time in reference seconds to an x position in the roll. */
    xFor(time) {
        return (Math.max(time, 0) / this.duration) * WIDTH;
    }

    /** Lights up whatever is sounding at `time` (in reference seconds). */
    showTime(time) {
        const x = this.xFor(time);
        this.playhead?.setAttribute("x1", x);
        this.playhead?.setAttribute("x2", x);
        this.playhead?.classList.toggle("hidden", time < 0);

        for (const { element, note } of this.noteElements) {
            const sounding = time >= note.time && time < note.time + note.duration;
            if (sounding === this.lit.has(element)) continue;
            element.classList.toggle("lit", sounding);
            if (sounding) this.lit.add(element);
            else this.lit.delete(element);
        }
    }

    reset() {
        this.showTime(-1);
    }

    clear() {
        this.container.innerHTML = "";
        this.noteElements = [];
        this.lit.clear();
    }
}

function buildTimeline(midi) {
    const notes = [];
    for (const track of midi.tracks) {
        // Channel 10 is the drum kit: those note numbers are drum sounds, not
        // pitches, so they play as drums whichever instrument is picked.
        const isDrumTrack = track.instrument?.percussion === true || track.channel === 9;

        for (const note of track.notes) {
            notes.push({
                time: note.time,
                duration: note.duration,
                midi: note.midi,
                drumKey: isDrumTrack ? note.midi : null,
                velocity: Math.round((note.velocity ?? 0.8) * 127),
                step: -1,
            });
        }
    }
    notes.sort((a, b) => a.time - b.time);

    // The opening tempo, exact: the note times above are real seconds at the
    // file's own tempo, so a rounded figure would put the slider slightly off
    // it. A file with no tempo event plays at 120 BPM - the MIDI standard's
    // default, and the tempo those note times were worked out at.
    const bpm = midi.header.tempos[0]?.bpm ?? MIDI_DEFAULT_BPM;
    const duration = Math.max(midi.duration, ...notes.map((n) => n.time + n.duration), 1);

    return {
        scoreBpm: bpm,
        bpm,
        notes,
        steps: [], // no notation to step through
        beats: beatGrid(midi),
        countIn: countInBar(midi),
        duration,
        isPianoRoll: true,
    };
}

/** Beat clicks straight off the MIDI tempo map and time signatures. */
function beatGrid(midi) {
    const beats = [];
    const ppq = midi.header.ppq;
    const changes = midi.header.timeSignatures.length
        ? [...midi.header.timeSignatures].sort((a, b) => a.ticks - b.ticks)
        : [{ ticks: 0, timeSignature: [4, 4] }];

    for (let i = 0; i < changes.length; i++) {
        const [numerator, denominator] = changes[i].timeSignature;
        const beatTicks = (ppq * 4) / denominator;
        const until = changes[i + 1]?.ticks ?? midi.durationTicks;

        let index = 0;
        for (let ticks = changes[i].ticks; ticks < until; ticks += beatTicks) {
            beats.push({
                time: midi.header.ticksToSeconds(ticks),
                accent: index % numerator === 0,
            });
            index += 1;
        }
    }
    return beats;
}

function countInBar(midi) {
    const [numerator, denominator] = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
    const ppq = midi.header.ppq;
    const beatSeconds = midi.header.ticksToSeconds((ppq * 4) / denominator) || 0.5;

    return Array.from({ length: numerator }, (_, i) => ({
        time: (i - numerator) * beatSeconds,
        accent: i === 0,
    }));
}
