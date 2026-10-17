// Renders MusicXML with OpenSheetMusicDisplay and reads a playable timeline out
// of it: note events, cursor steps and a metronome beat grid.
//
// Everything in the timeline is measured in "reference seconds" - seconds at
// the score's own tempo. The player scales them by scoreBpm / chosenBpm, so the
// tempo slider works even when the score changes tempo part-way through.

import { gmKeyFromStaffPosition } from "./drums.js";
import { readTempoMap } from "./tempo.js";

const DEFAULT_BPM = 100;

/** OSMD's MidiInstrument value for a part on MIDI channel 10. */
const PERCUSSION = 128;

/** Shortest a note is allowed to sound, so grace notes still make a sound. */
const MIN_NOTE_SECONDS = 0.06;

/** A whole note is 4 quarter notes; MusicXML tempo is quarter notes per minute. */
function toSeconds(wholeNotes, bpm) {
    return (wholeNotes * 4 * 60) / bpm;
}

/**
 * MIDI number from a written pitch, so that C4 (MusicXML octave 4) is 60.
 * OSMD stores octaves shifted down by Pitch.OctaveXmlDifference, so that has
 * to be added back.
 */
function midiOf(note) {
    const pitch = note.Pitch;
    if (!pitch) return null;

    const xmlOffset = opensheetmusicdisplay.Pitch?.OctaveXmlDifference ?? 3;
    return (
        (pitch.Octave + xmlOffset + 1) * 12 + pitch.FundamentalNote + pitch.AccidentalHalfTones
    );
}

/**
 * How far a note's part says it sounds from where it is written, in semitones,
 * from the part's MusicXML <transpose>; null when the part does not say. OSMD
 * keeps no difference between "says 0" and "says nothing", so 0 is "nothing".
 */
function declaredTranspose(note) {
    const semitones = note.ParentStaff?.ParentInstrument?.PlaybackTranspose;
    return Number.isFinite(semitones) && semitones !== 0 ? semitones : null;
}

/**
 * A drum note's General MIDI percussion key, or null if the note is pitched.
 * Unpitched notes still carry a pitch in OSMD (that is how they get drawn on
 * the right line), so the part's MIDI channel is what marks them as drums.
 */
function percussionKey(note, midi) {
    const instrument = note.ParentStaff?.ParentInstrument;
    if (instrument?.MidiInstrumentId !== PERCUSSION) return null;

    // The score's own <midi-unpitched> mapping is authoritative when it exists.
    const sub = instrument.SubInstruments?.find((s) => s.idString === note.PlaybackInstrumentId);
    if (sub?.fixedKey > 0) return sub.fixedKey - 1; // MusicXML counts from 1

    return gmKeyFromStaffPosition(midi);
}

export class Score {
    constructor(container) {
        this.container = container;
        this.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
            autoResize: true,
            backend: "svg",
            // The page shows the title above the score already, and a long one
            // centred inside the engraving overflows a narrow screen on both
            // sides, which is what clipped it on a phone.
            drawTitle: false,
            drawSubtitle: false,
            drawComposer: false,
            // Beam eighths and shorter by the beat, as printed music does. This
            // only touches notes with no <beam> in the XML, so a file that
            // says how it is beamed keeps its own beaming.
            autoBeam: true,
            drawingParameters: "default",
            // Following the cursor is done here (revealCursor): OSMD's own
            // follow never scrolled the page as the cursor is moved here.
            followCursor: false,
            cursorsOptions: [{ type: 0, color: "#2563eb", alpha: 0.25, follow: false }],
        });
        this.litElements = [];
        this.stepIndex = -1;
        this.userZoom = null; // set once the size slider is touched

        // Re-fit when the window changes shape, e.g. a phone being turned.
        window.addEventListener("resize", () => this.scheduleRefit());
    }

    /** Re-fitting re-engraves, so coalesce bursts of resize events. */
    scheduleRefit() {
        if (!this.osmd.Sheet) return;
        clearTimeout(this.refitTimer);
        this.refitTimer = setTimeout(() => {
            const changed = this.applyResponsiveOptions();
            if (changed) this.osmd.render();
            if (this.userZoom === null) this.fitToWidth();
            else if (changed) this.restoreCursor();
        }, 250);
    }

    /**
     * OSMD lays music out as a printed page, with margins to match. Inside a
     * card on a phone those margins are just empty paper, so they come down.
     */
    trimPageMargins() {
        const rules = this.osmd.EngravingRules;
        if (!rules) return;
        // Only the vertical margins come down. Narrowing the horizontal ones
        // gives the layout engine more room, which it spends packing more bars
        // onto each system - the opposite of what a phone wants, where fewer
        // and larger bars per line is what makes it readable.
        const tight = window.innerWidth < 700;
        rules.PageTopMargin = tight ? 0.5 : 2;
        rules.PageBottomMargin = tight ? 0.5 : 2;
    }

    /**
     * Part names are printed to the left of every system, which is a luxury a
     * phone cannot afford. Returns whether the setting changed.
     */
    applyResponsiveOptions() {
        const wide = window.innerWidth >= 700;
        if (wide === this.showingPartNames) return false;

        this.showingPartNames = wide;
        this.osmd.setOptions({ drawPartNames: wide, drawPartAbbreviations: wide });
        return true;
    }

    /**
     * Engraves at whatever zoom makes the music fit the container's width.
     * OSMD lays a system out to the container, but it will not compress past a
     * minimum, so on a phone the staff overflows and gets clipped. Measuring
     * what it actually drew and scaling to that is what makes a score readable
     * on a narrow screen.
     */
    fitToWidth() {
        // The SVG element is already clamped to its container, so measuring it
        // says nothing. What matters is the box the engraving actually draws
        // into, which on a narrow screen runs outside the element on both
        // sides - that is what clips the title and the last bar.
        for (let pass = 0; pass < 4; pass++) {
            const svg = this.container.querySelector("svg");
            if (!svg) return;

            const available = svg.getBoundingClientRect().width;
            const box = svg.getBBox();
            const needed = Math.max(box.width, box.x + box.width);
            // Nothing to measure (hidden, or empty): leave the zoom alone, but
            // still put back what the render wiped.
            if (available <= 0 || needed <= 0) break;

            const fits = needed <= available + 1 && box.x >= -1;
            if (fits) break;

            // A little under the exact ratio, so rounding cannot leave it
            // one pixel too wide and send us round again.
            const next = Math.min(1, Math.max(0.3, (this.osmd.zoom * available * 0.98) / needed));
            if (Math.abs(next - this.osmd.zoom) < 0.01) break;

            this.osmd.zoom = next;
            this.osmd.render();
        }

        this.restoreCursor();
        return this.osmd.zoom;
    }

    /** A re-render replaces the SVG, so the cursor, colours and marks start over. */
    restoreCursor() {
        this.drawMarks();
        const step = this.stepIndex;
        this.litElements = [];
        this.stepIndex = -1;
        this.osmd.cursor.reset();
        this.osmd.cursor.hide();
        if (step >= 0) this.showStep(step);
    }

    /** `content` is a MusicXML string, or a Blob for a compressed .mxl file. */
    async load(content) {
        // OSMD treats a string that does not look like XML as a URL to fetch,
        // so a file of the wrong kind would turn into a stray request and a
        // confusing error. Check it here instead.
        if (typeof content === "string" && !/<\s*score-(partwise|timewise)/i.test(content)) {
            throw new Error("That does not look like MusicXML - no <score-partwise> in it.");
        }

        this.applyResponsiveOptions();
        await this.osmd.load(content);
        // Tempo is read from the text: OSMD misreads metronome marks in
        // anything but quarter notes, and rounds the rest (see tempo.js).
        this.tempos = typeof content === "string" ? readTempoMap(content) : null;
        // A lone part's name beside the staff only repeats the title above it.
        if (this.osmd.Sheet.Instruments.length < 2 && this.showingPartNames) {
            this.osmd.setOptions({ drawPartNames: false, drawPartAbbreviations: false });
            this.showingPartNames = false;
        }
        this.trimPageMargins();
        this.marked = new Set();
        this.osmd.zoom = 1;
        this.osmd.render();
        if (this.userZoom === null) this.fitToWidth();
        this.osmd.cursor.reset();
        this.osmd.cursor.hide();
        this.stepIndex = -1;
        this.litElements = [];
        return this.buildTimeline();
    }

    get title() {
        return this.osmd.Sheet?.TitleString || "";
    }

    /**
     * Walks the score once with OSMD's own iterator - which unrolls repeats and
     * follows tempo changes - and records what to play, when to move the cursor,
     * and where the metronome beats fall.
     */
    buildTimeline() {
        const sheet = this.osmd.Sheet;
        const tempos = this.tempos;
        // OSMD's own reading of the tempo, used only without a tempo map.
        const osmdBpm = sheet.HasBPMInfo ? Math.round(sheet.DefaultStartTempoInBpm) : null;
        const osmdFallback = osmdBpm || DEFAULT_BPM;
        // From the tempo map: the tempo now, the changes still to come in
        // this measure, and the tempo the piece starts at (null if unmarked).
        let marked = null;
        let pending = [];
        let startBpm;
        let lastBpm = null;

        this.osmd.cursor.reset();
        const iterator = this.osmd.cursor.iterator.clone();

        const notes = [];
        const steps = [];
        const measures = [];
        let time = 0;
        let lastMeasureKey = null;
        // Repeats mean a bounded score can still be a long walk; this only
        // stops a malformed score from hanging the page.
        let guard = 0;

        while (!iterator.EndReached && guard++ < 200000) {
            const measure = iterator.CurrentMeasure;
            const intoMeasure = iterator.CurrentRelativeInMeasureTimestamp?.RealValue ?? 0;

            // A new measure starts here (or the same measure again, on a repeat).
            const measureKey = `${iterator.CurrentMeasureIndex}:${iterator.CurrentRepetitionIteration}`;
            const newMeasure = measureKey !== lastMeasureKey;
            if (tempos && newMeasure) {
                // A mark after a measure's last note still holds from the next.
                for (const event of pending) marked = event.bpm;
                pending = [...(tempos.get(iterator.CurrentMeasureIndex) ?? [])];
            }
            while (pending.length && pending[0].at <= intoMeasure + 1e-9) marked = pending.shift().bpm;
            const bpm = tempos ? marked ?? DEFAULT_BPM : iterator.CurrentBpm || osmdFallback;
            if (startBpm === undefined) startBpm = tempos ? marked : osmdBpm;

            if (newMeasure) {
                lastMeasureKey = measureKey;
                const start = time - toSeconds(intoMeasure, bpm);
                measures.push({
                    time: start,
                    number: measure.MeasureNumber,
                    beats: measure.ActiveTimeSignature.Numerator,
                    beatLength: 1 / measure.ActiveTimeSignature.Denominator,
                    lengthWhole: measure.Duration.RealValue,
                    timeSignatureWhole: measure.ActiveTimeSignature.RealValue,
                    bpm,
                    // Where the tempo changes within the measure, for the clicks.
                    segments: [{ at: 0, time: start, bpm }],
                });
            } else if (bpm !== lastBpm) {
                measures.at(-1).segments.push({ at: intoMeasure, time, bpm });
            }
            lastBpm = bpm;

            // cursor.next() stops only on positions with something visible, so
            // the cursor steps are exactly those positions.
            const isCursorStep = iterator.CurrentVisibleVoiceEntries().length > 0;
            const stepIndex = isCursorStep ? steps.length : -1;
            // `at` is where the step sits in the score as written, in whole
            // notes: the same for each pass through a repeat, and what a tap
            // on a note is matched against.
            if (isCursorStep) {
                steps.push({ time, measure: measure.MeasureNumber, at: iterator.CurrentSourceTimestamp.RealValue });
            }

            let longestHere = 0;
            for (const voiceEntry of iterator.CurrentVoiceEntries) {
                for (const note of voiceEntry.Notes) {
                    if (note.isRest()) continue;

                    // A tie sounds as one held note: play it at its start note
                    // for the whole tied length, and skip the continuations.
                    const tie = note.NoteTie;
                    if (tie && tie.StartNote !== note) continue;
                    const lengthWhole = tie ? tie.Duration.RealValue : note.Length.RealValue;

                    const midi = midiOf(note);
                    if (midi === null) continue;

                    longestHere = Math.max(longestHere, lengthWhole);
                    const drumKey = percussionKey(note, midi);
                    notes.push({
                        time,
                        duration: Math.max(toSeconds(lengthWhole, bpm), MIN_NOTE_SECONDS),
                        midi,
                        drumKey, // non-null for a note on a percussion staff
                        // The part's own transposition, if its MusicXML gives one.
                        transpose: drumKey === null ? declaredTranspose(note) : null,
                        step: stepIndex,
                    });
                }
            }

            // The enrolled timestamp counts time as played, so it keeps rising
            // through repeats instead of jumping back.
            const before = iterator.CurrentEnrolledTimestamp.RealValue;
            iterator.moveToNext();
            const delta = iterator.EndReached
                ? longestHere
                : iterator.CurrentEnrolledTimestamp.RealValue - before;
            time += toSeconds(Math.max(delta, 0), bpm);
        }

        const duration = Math.max(time, ...notes.map((n) => n.time + n.duration), 0);
        const scoreBpm = startBpm ?? null;
        const fallbackBpm = scoreBpm ?? DEFAULT_BPM;

        return {
            scoreBpm,
            bpm: fallbackBpm,
            // Semitones the score's own <transpose> moves it, if any part has one.
            transposedBy: notes.find((n) => n.transpose !== null)?.transpose ?? null,
            notes,
            steps,
            beats: beatGrid(measures),
            countIn: countInBar(measures, fallbackBpm),
            duration,
            measureCount: measures.length,
        };
    }

    /**
     * Re-engraves at a size you chose, which turns off automatic fitting:
     * once you have picked a size, a resize should not overrule it.
     */
    setZoom(factor) {
        if (!this.osmd.Sheet) return;
        this.userZoom = factor;
        this.osmd.zoom = factor;
        this.osmd.render();
        this.restoreCursor();
    }

    /** Hands the size control back to automatic fitting. */
    fitAgain() {
        this.userZoom = null;
        this.osmd.zoom = 1;
        this.osmd.render();
        this.fitToWidth();
        return this.osmd.zoom;
    }

    /** Moves the cursor to a step and lights up the notes under it. */
    showStep(index) {
        if (index === this.stepIndex) return;

        const cursor = this.osmd.cursor;
        if (!cursor) return; // nothing rendered yet, so there is no cursor
        if (index < 0) {
            cursor.reset();
            cursor.hide();
            this.stepIndex = -1;
            this.clearLit();
            return;
        }

        // A freshly reset cursor is already on step 0 - that is the position
        // buildTimeline() recorded as step 0 - so it must not be stepped past.
        // Starting from -1 here put the highlight one note ahead of the audio.
        if (this.stepIndex < 0 || index < this.stepIndex) {
            cursor.reset();
            this.stepIndex = 0;
        }
        while (this.stepIndex < index && !cursor.iterator.EndReached) {
            cursor.next();
            this.stepIndex += 1;
        }
        cursor.show();
        this.lightUpNotesUnderCursor();
        this.revealCursor();
    }

    /**
     * Scrolls the highlighted notes back into view once they have left it -
     * below the screen, say, or behind the play bar on a phone. The page's
     * scroll padding says how much the bars cover, and scrollIntoView keeps
     * clear of them.
     */
    revealCursor() {
        const element = this.osmd.cursor?.cursorElement;
        if (!element?.isConnected) return;
        const box = element.getBoundingClientRect();
        const page = getComputedStyle(document.documentElement);
        const top = parseFloat(page.scrollPaddingTop) || 0;
        const bottom = window.innerHeight - (parseFloat(page.scrollPaddingBottom) || 0);
        if (box.top < top || box.bottom > bottom) {
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        }
    }

    lightUpNotesUnderCursor() {
        this.clearLit();
        for (const gNote of this.osmd.cursor.GNotesUnderCursor()) {
            // Colouring the SVG group directly avoids a re-render per beat.
            const element = gNote.getSVGGElement?.();
            if (!element) continue;
            element.classList.add("note-lit");
            this.litElements.push(element);
        }
    }

    clearLit() {
        for (const element of this.litElements) element.classList.remove("note-lit");
        this.litElements = [];
    }

    /**
     * The note or rest drawn nearest a point on screen, as where it starts in
     * whole notes from the beginning of the score, or null when none is within
     * reach. A fingertip covers more than a notehead on a phone, so a tap
     * takes the nearest note rather than needing a direct hit.
     */
    noteAt(clientX, clientY, reach = 24) {
        let best = null;
        for (const staves of this.osmd.GraphicSheet?.MeasureList ?? []) {
            for (const measure of staves) {
                for (const entry of measure?.staffEntries ?? []) {
                    for (const voiceEntry of entry.graphicalVoiceEntries) {
                        for (const gNote of voiceEntry.notes) {
                            const box = gNote.getSVGGElement?.()?.getBoundingClientRect();
                            if (!box?.width) continue;

                            // How far outside the note's box the point is, and
                            // as a tie-break where boxes overlap, from its middle.
                            const outside = Math.hypot(
                                Math.max(box.left - clientX, 0, clientX - box.right),
                                Math.max(box.top - clientY, 0, clientY - box.bottom),
                            );
                            const fromMiddle = Math.hypot(
                                clientX - (box.left + box.right) / 2,
                                clientY - (box.top + box.bottom) / 2,
                            );
                            if (outside > reach) continue;
                            if (best && (outside > best.outside ||
                                (outside === best.outside && fromMiddle >= best.fromMiddle))) continue;
                            best = { outside, fromMiddle, note: gNote.sourceNote };
                        }
                    }
                }
            }
        }
        return best ? best.note.getAbsoluteTimestamp().RealValue : null;
    }

    /**
     * Shades the bars with these numbers - ones a reading got wrong - so they
     * can be found on the score rather than counted to. Until the next score.
     */
    markBars(numbers) {
        this.marked = new Set((numbers ?? []).map(String));
        this.drawMarks();
    }

    drawMarks() {
        const svg = this.container.querySelector("svg");
        if (!svg) return;
        for (const old of svg.querySelectorAll(".bar-mark")) old.remove();
        if (!this.marked?.size) return;

        // OSMD lays out in units of 10 pixels at zoom 1.
        const unit = 10 * this.osmd.zoom;
        for (const staves of this.osmd.GraphicSheet?.MeasureList ?? []) {
            const shown = staves.filter(Boolean);
            const number = shown[0]?.MeasureNumber ?? shown[0]?.parentSourceMeasure?.MeasureNumber;
            if (!shown.length || !this.marked.has(String(number))) continue;

            // Every staff of the bar, top to bottom, as one box.
            const boxes = shown.map(({ PositionAndShape: p }) => ({
                left: p.AbsolutePosition.x + p.BorderLeft,
                right: p.AbsolutePosition.x + p.BorderRight,
                top: p.AbsolutePosition.y + p.BorderTop,
                bottom: p.AbsolutePosition.y + p.BorderBottom,
            }));
            const left = Math.min(...boxes.map((b) => b.left));
            const right = Math.max(...boxes.map((b) => b.right));
            const top = Math.min(...boxes.map((b) => b.top)) - 1;
            const bottom = Math.max(...boxes.map((b) => b.bottom)) + 1;

            const mark = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            mark.setAttribute("class", "bar-mark");
            mark.setAttribute("x", left * unit);
            mark.setAttribute("y", top * unit);
            mark.setAttribute("width", (right - left) * unit);
            mark.setAttribute("height", (bottom - top) * unit);
            mark.setAttribute("rx", 4);
            // Behind the notes, so they stay readable.
            svg.insertBefore(mark, svg.firstChild);
        }
    }

    reset() {
        this.clearLit();
        this.stepIndex = -1;
        if (!this.osmd.cursor) return;
        this.osmd.cursor.reset();
        this.osmd.cursor.hide();
    }

    clear() {
        this.clearLit();
        this.container.innerHTML = "";
    }
}

/**
 * One click per beat of the time signature, for every measure as played - six
 * eighth-note clicks in 6/8. Beat 1 is accented, except in a pickup measure,
 * where the clicks fill the short measure but the bar has no real downbeat.
 */
function beatGrid(measures) {
    const beats = [];
    for (const measure of measures) {
        const isFullBar = measure.lengthWhole >= measure.timeSignatureWhole - 1e-6;
        for (let i = 0; i < measure.beats; i++) {
            const offset = i * measure.beatLength;
            if (offset >= measure.lengthWhole - 1e-6) break; // pickup: stop at the barline
            // From the last tempo change at or before the beat, at that tempo.
            const segment = measure.segments.findLast((s) => s.at <= offset + 1e-9);
            beats.push({
                time: segment.time + toSeconds(offset - segment.at, segment.bpm),
                accent: i === 0 && isFullBar,
            });
        }
    }
    return beats.sort((a, b) => a.time - b.time);
}

/**
 * Clicks before the music, in the opening time signature: one full bar. A
 * piece that opens with a pickup instead gets the beats of the pickup's bar
 * that come before it, so the pickup comes in on its own beat - "1, 2, 3",
 * and in on 4 - with a full bar in front when that alone would be too few
 * clicks to catch the tempo from.
 */
function countInBar(measures, fallbackBpm) {
    const first = measures[0];
    const beats = first?.beats ?? 4;
    const beatLength = first?.beatLength ?? 0.25;
    const bpm = first?.bpm ?? fallbackBpm;

    // Where in its bar the music starts, in whole notes: 0 unless a pickup.
    const isPickup = first && first.lengthWhole < first.timeSignatureWhole - 1e-6;
    const startsAt = isPickup ? first.timeSignatureWhole - first.lengthWhole : 0;
    const beatsBefore = Math.ceil(startsAt / beatLength - 1e-6);

    // Clicks by beat of the bar, counting from the pickup bar's beat 1.
    let beat = startsAt > 0 ? 0 : -beats;
    if (startsAt > 0 && beatsBefore < 2) beat -= beats;

    const clicks = [];
    for (; beat * beatLength < startsAt - 1e-9; beat++) {
        clicks.push({
            time: toSeconds(beat * beatLength - startsAt, bpm), // negative: before the music
            accent: ((beat % beats) + beats) % beats === 0,
        });
    }
    return clicks;
}
