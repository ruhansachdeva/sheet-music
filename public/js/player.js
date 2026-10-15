// Playback engine.
//
// All audio - notes and metronome clicks alike - is scheduled on the Web Audio
// clock by a look-ahead scheduler: a timer wakes up often, looks a fraction of
// a second ahead, and hands every event in that window to the audio graph with
// an exact start time. Nothing is played by setTimeout, so the timing does not
// drift when the main thread is busy. The visuals run off requestAnimationFrame
// and read the same audio clock, so sound and highlighting stay together.

import { Soundfont, DrumMachine } from "https://cdn.jsdelivr.net/npm/smplr@1.1.0/+esm";
import { INSTRUMENTS, concertPitch } from "./instruments.js";
import { DRUM_MACHINE, resolveDrumName } from "./drums.js";

/** How far ahead to schedule. Short while the tab is in front, so stopping is
 *  responsive. Browsers throttle timers in a background tab to about once a
 *  second, so a hidden tab schedules much further ahead to stay fed. Either way
 *  every scheduled note keeps a cancel function, so stopping still works. */
const LOOKAHEAD_VISIBLE = 0.15;
const LOOKAHEAD_HIDDEN = 2;

/** How often the scheduler wakes up. Far shorter than LOOKAHEAD, so a late
 *  wake-up still leaves time to schedule. */
const TICK_MS = 25;

/** A beat of silence before the first note, to get the scheduler ahead of the clock. */
const LEAD_IN = 0.12;

/** Played past the end before stopping, so the last note can ring. */
const TAIL = 0.4;

export class Player {
    constructor({ onPosition, onState, onInstrumentLoading } = {}) {
        this.onPosition = onPosition ?? (() => {});
        this.onState = onState ?? (() => {});
        this.onInstrumentLoading = onInstrumentLoading ?? (() => {});

        this.ctx = null;
        this.melodic = null;
        this.drumMachine = null;
        this.drumNames = [];
        this.instrumentKey = null;

        this.timeline = null;
        this.tempo = 100;
        this.transposeEnabled = true;
        this.options = { countIn: false, metronome: false };

        this.state = "stopped";
        this.musicStart = 0;
        this.scale = 1;
        this.events = [];
        this.eventIndex = 0;
        this.scheduledUntil = 0;
        this.pausedAt = 0;
        this.clicks = [];
        this.sounding = [];
        this.lookahead = LOOKAHEAD_VISIBLE;
        this.timer = null;
        this.frame = null;

        document.addEventListener("visibilitychange", () => this.adjustLookahead());
    }

    /** A hidden tab gets its timers throttled, so it needs a bigger window. */
    adjustLookahead() {
        this.lookahead = document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD_VISIBLE;
        if (this.state === "playing") this.tick(); // fill the wider window now
    }

    // --- audio setup ---------------------------------------------------------

    /** The context is created up front (suspended) so samples can preload. */
    audioContext() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.clickBus = this.ctx.createGain();
            this.clickBus.gain.value = 0.9;
            this.clickBus.connect(this.ctx.destination);
        }
        return this.ctx;
    }

    async setInstrument(key) {
        this.instrumentKey = key;
        const definition = INSTRUMENTS[key];
        const ctx = this.audioContext();

        if (definition.drums) {
            await this.loadDrums();
            return;
        }

        this.onInstrumentLoading(true, { instrument: definition.label, progress: 0 });
        try {
            const instrument = Soundfont(ctx, {
                instrument: definition.soundfont,
                volume: 100,
                onLoadProgress: ({ loaded, total }) =>
                    this.onInstrumentLoading(true, {
                        instrument: definition.label,
                        progress: total ? loaded / total : 0,
                    }),
            });
            await instrument.ready;
            // A slow network can finish a load the user has already moved on from.
            if (this.instrumentKey !== key) {
                instrument.dispose();
                return;
            }
            this.melodic?.dispose();
            this.melodic = instrument;
        } catch (error) {
            throw new Error(`Could not load the ${definition.label} samples: ${error.message}`);
        } finally {
            this.onInstrumentLoading(false);
        }
    }

    /** The drum machine is shared: a drum part plays through it whatever
     *  melodic instrument is picked. */
    async loadDrums() {
        if (this.drumMachine) return;

        this.onInstrumentLoading(true, { instrument: "drums", progress: 0 });
        try {
            const machine = DrumMachine(this.audioContext(), {
                instrument: DRUM_MACHINE,
                onLoadProgress: ({ loaded, total }) =>
                    this.onInstrumentLoading(true, {
                        instrument: "drums",
                        progress: total ? loaded / total : 0,
                    }),
            });
            await machine.ready;
            this.drumMachine = machine;
            this.drumNames = machine.getGroupNames();
        } catch (error) {
            throw new Error(`Could not load the drum samples: ${error.message}`);
        } finally {
            this.onInstrumentLoading(false);
        }
    }

    // --- loading a piece ----------------------------------------------------

    setTimeline(timeline) {
        this.stop();
        this.timeline = timeline;
        this.transposeEnabled = !timeline.isPianoRoll;
        this.tempo = timeline.bpm;

        // Preload the kit when the piece contains drum notes.
        if (timeline.notes.some((note) => note.drumKey !== null)) this.loadDrums();
    }

    setTempo(bpm) {
        this.tempo = bpm;
        if (this.state === "playing") this.retime();
    }

    setOption(name, value) {
        this.options[name] = value;
        // Rebuild the queue so the change applies from here on, without
        // re-scheduling what has already been handed to the audio graph.
        if (this.state === "playing") this.rebuildQueue(this.scheduledUntil, this.countingIn);
    }

    // --- transport ----------------------------------------------------------

    async play() {
        if (!this.timeline || this.state === "playing") return;

        const ctx = this.audioContext();
        if (ctx.state === "suspended") await ctx.resume();
        if (!this.melodic && !INSTRUMENTS[this.instrumentKey]?.drums) {
            await this.setInstrument(this.instrumentKey);
        }

        const startAt = this.state === "paused" ? this.pausedAt : 0;
        const withCountIn = this.options.countIn && this.state !== "paused";

        this.scale = this.timeline.bpm / this.tempo;
        const countInLength =
            withCountIn && this.timeline.countIn.length ? -this.timeline.countIn[0].time : 0;
        this.musicStart = ctx.currentTime + LEAD_IN + (countInLength - startAt) * this.scale;

        // Kept, so a rebuild part-way through the count-in keeps the rest of it.
        this.countingIn = withCountIn;
        this.rebuildQueue(startAt, withCountIn);
        this.state = "playing";
        this.onState(this.state);

        this.timer = setInterval(() => this.tick(), TICK_MS);
        this.frame = requestAnimationFrame(() => this.draw());
        this.tick();
    }

    pause() {
        if (this.state !== "playing") return;
        this.pausedAt = Math.min(Math.max(this.position(), 0), this.timeline.duration);
        this.silence();
        this.stopTimers();
        this.state = "paused";
        this.onState(this.state);
    }

    stop() {
        this.silence();
        this.stopTimers();
        this.pausedAt = 0;
        this.state = "stopped";
        this.onState(this.state);
        this.onPosition(-1, -1);
    }

    toggle() {
        return this.state === "playing" ? this.pause() : this.play();
    }

    /** Current position in reference seconds; negative during the count-in. */
    position() {
        if (!this.ctx) return 0;
        if (this.state !== "playing") return this.pausedAt;
        return (this.ctx.currentTime - this.musicStart) / this.scale;
    }

    /** Keeps the position while the tempo changes under it. */
    retime() {
        const here = this.position();
        this.silence();
        this.scale = this.timeline.bpm / this.tempo;
        this.musicStart = this.ctx.currentTime + LEAD_IN - here * this.scale;
        this.rebuildQueue(here, this.countingIn);
    }

    // --- scheduling ---------------------------------------------------------

    rebuildQueue(fromRef, withCountIn = false) {
        const events = [];
        const epsilon = 1e-6;

        for (const note of this.timeline.notes) {
            if (note.time >= fromRef - epsilon) events.push({ time: note.time, note });
        }
        if (this.options.metronome) {
            for (const beat of this.timeline.beats) {
                if (beat.time >= fromRef - epsilon) events.push({ time: beat.time, click: beat });
            }
        }
        if (withCountIn) {
            for (const beat of this.timeline.countIn) {
                if (beat.time >= fromRef - epsilon) events.push({ time: beat.time, click: beat });
            }
        }

        events.sort((a, b) => a.time - b.time);
        this.events = events;
        this.eventIndex = 0;
        this.scheduledUntil = fromRef;
    }

    tick() {
        if (this.state !== "playing") return;

        const here = this.position();
        const horizon = here + this.lookahead / this.scale;
        while (this.eventIndex < this.events.length && this.events[this.eventIndex].time <= horizon) {
            const event = this.events[this.eventIndex++];
            const when = this.musicStart + event.time * this.scale;
            if (event.click) this.playClick(when, event.click.accent);
            else this.playNote(event.note, when);
        }
        this.scheduledUntil = Math.max(this.scheduledUntil, horizon);

        // Forget the cancel functions of notes that have finished sounding.
        this.sounding = this.sounding.filter((voice) => voice.until > here - 0.5);

        if (here >= this.timeline.duration + TAIL) this.stop();
    }

    playNote(note, when) {
        const definition = INSTRUMENTS[this.instrumentKey] ?? {};

        // A drum note, or any note at all when the kit is the chosen instrument.
        if (note.drumKey !== null || definition.drums) {
            if (!this.drumMachine) return;
            const key = note.drumKey ?? note.midi;
            // No duration: a drum sample rings for its own length.
            const stop = this.drumMachine.start({
                note: resolveDrumName(key, this.drumNames),
                time: when,
                velocity: note.velocity ?? 100,
            });
            this.remember(stop, note);
            return;
        }

        if (!this.melodic) return;
        const stop = this.melodic.start({
            note: concertPitch(note.midi, this.instrumentKey, this.transposeEnabled),
            time: when,
            duration: note.duration * this.scale,
            velocity: note.velocity ?? 100,
        });
        this.remember(stop, note);
    }

    /** Keeps a note's cancel function, so pause and stop can silence it even
     *  when it was scheduled well ahead of the clock. */
    remember(stop, note) {
        if (typeof stop === "function") {
            this.sounding.push({ stop, until: note.time + note.duration });
        }
    }

    /**
     * Sounds one note immediately, for the note writer: pressing a key should
     * make a sound the way a keyboard does.
     */
    async preview(midi, seconds = 0.6) {
        const ctx = this.audioContext();
        if (ctx.state === "suspended") await ctx.resume();
        if (!this.melodic && !INSTRUMENTS[this.instrumentKey]?.drums) {
            await this.setInstrument(this.instrumentKey);
        }

        const definition = INSTRUMENTS[this.instrumentKey] ?? {};
        if (definition.drums) {
            this.drumMachine?.start({ note: resolveDrumName(midi, this.drumNames) });
            return;
        }
        this.melodic?.start({
            note: concertPitch(midi, this.instrumentKey, this.transposeEnabled),
            duration: seconds,
        });
    }

    /**
     * Gets the sound ready before it is needed. The writer calls this when it
     * opens, so the first key tapped is not silent while samples download.
     */
    async warmUp() {
        const ctx = this.audioContext();
        if (ctx.state === "suspended") await ctx.resume().catch(() => {});
        if (INSTRUMENTS[this.instrumentKey]?.drums) await this.loadDrums();
        else if (!this.melodic) await this.setInstrument(this.instrumentKey);
    }

    /** True once there is something loaded that can make a sound. */
    get ready() {
        return INSTRUMENTS[this.instrumentKey]?.drums
            ? Boolean(this.drumMachine)
            : Boolean(this.melodic);
    }

    /** Sounds one kit piece, for the writer's drum pads. */
    async previewDrum(gmKey) {
        const ctx = this.audioContext();
        if (ctx.state === "suspended") await ctx.resume();
        await this.loadDrums();
        this.drumMachine?.start({ note: resolveDrumName(gmKey, this.drumNames) });
    }

    /** A short sine blip, higher and louder on beat 1. */
    playClick(when, accent) {
        const ctx = this.ctx;
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();

        oscillator.type = "sine";
        oscillator.frequency.value = accent ? 1600 : 1000;
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(accent ? 0.5 : 0.22, when + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);

        oscillator.connect(gain).connect(this.clickBus);
        oscillator.start(when);
        oscillator.stop(when + 0.07);

        this.clicks.push(oscillator);
        oscillator.onended = () => {
            this.clicks = this.clicks.filter((o) => o !== oscillator);
        };
    }

    // --- visuals ------------------------------------------------------------

    draw() {
        if (this.state !== "playing") return;
        const here = this.position();
        this.onPosition(here, this.stepAt(here));
        this.frame = requestAnimationFrame(() => this.draw());
    }

    /** The last cursor step at or before `time`. During the count-in, the first. */
    stepAt(time) {
        const steps = this.timeline?.steps ?? [];
        if (steps.length === 0) return -1;
        if (time < 0) return 0;

        let low = 0;
        let high = steps.length - 1;
        let found = 0;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (steps[mid].time <= time + 1e-6) {
                found = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return found;
    }

    // --- teardown -----------------------------------------------------------

    silence() {
        // Cancel each scheduled note individually: this also drops notes that
        // are queued but have not started, which stop() alone would not.
        for (const voice of this.sounding) {
            try {
                voice.stop();
            } catch {
                // The instrument was replaced or disposed; nothing to cancel.
            }
        }
        this.sounding = [];

        this.melodic?.stop();
        this.drumMachine?.stop();
        for (const oscillator of this.clicks) {
            try {
                oscillator.stop(this.ctx.currentTime);
            } catch {
                // Already finished; nothing to cancel.
            }
        }
        this.clicks = [];
    }

    stopTimers() {
        if (this.timer) clearInterval(this.timer);
        if (this.frame) cancelAnimationFrame(this.frame);
        this.timer = null;
        this.frame = null;
    }
}
