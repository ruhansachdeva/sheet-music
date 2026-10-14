// MIDI files carry no notation, so they get a piano roll instead of a score.
// The timeline shape is the same one score.js produces, so the player does not
// care which kind of file is loaded.

import { Midi } from "https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/+esm";

const DEFAULT_BPM = 100;

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

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "piano-roll");
        svg.setAttribute("viewBox", `0 0 1000 ${rows * 8}`);
        svg.setAttribute("preserveAspectRatio", "none");

        // A faint stripe behind every black key, so the pitches stay readable.
        for (let midi = low; midi <= high; midi++) {
            if (![1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12)) continue;
            const row = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            row.setAttribute("x", 0);
            row.setAttribute("y", (high - midi) * 8);
            row.setAttribute("width", 1000);
            row.setAttribute("height", 8);
            row.setAttribute("class", "roll-row");
            svg.appendChild(row);
        }

        // A bar line per metronome accent gives the roll a sense of metre.
        for (const beat of timeline.beats) {
            if (!beat.accent) continue;
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            const x = (beat.time / this.duration) * 1000;
            line.setAttribute("x1", x);
            line.setAttribute("x2", x);
            line.setAttribute("y1", 0);
            line.setAttribute("y2", rows * 8);
            line.setAttribute("class", "roll-bar");
            svg.appendChild(line);
        }

        for (const note of timeline.notes) {
            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", (note.time / this.duration) * 1000);
            rect.setAttribute("y", (high - note.midi) * 8 + 1);
            rect.setAttribute("width", Math.max((note.duration / this.duration) * 1000, 1.5));
            rect.setAttribute("height", 6);
            rect.setAttribute("rx", 1.5);
            rect.setAttribute("class", "roll-note");
            svg.appendChild(rect);
            this.noteElements.push({ element: rect, note });
        }

        const playhead = document.createElementNS("http://www.w3.org/2000/svg", "line");
        playhead.setAttribute("y1", 0);
        playhead.setAttribute("y2", rows * 8);
        playhead.setAttribute("class", "roll-playhead");
        playhead.setAttribute("x1", 0);
        playhead.setAttribute("x2", 0);
        svg.appendChild(playhead);
        this.playhead = playhead;

        this.container.appendChild(svg);
    }

    /** Lights up whatever is sounding at `time` (in reference seconds). */
    showTime(time) {
        const x = (Math.max(time, 0) / this.duration) * 1000;
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
        for (const note of track.notes) {
            notes.push({
                time: note.time,
                duration: note.duration,
                midi: note.midi,
                velocity: Math.round((note.velocity ?? 0.8) * 100),
                step: -1,
            });
        }
    }
    notes.sort((a, b) => a.time - b.time);

    const bpm = midi.header.tempos[0]?.bpm
        ? Math.round(midi.header.tempos[0].bpm)
        : null;
    const duration = Math.max(midi.duration, ...notes.map((n) => n.time + n.duration), 1);

    return {
        scoreBpm: bpm,
        bpm: bpm || DEFAULT_BPM,
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
