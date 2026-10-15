// The tempo map, read from the MusicXML itself.
//
// OSMD reads a printed metronome mark as if its beat unit were always a
// quarter note - "half = 60" plays at 60 rather than 120, "eighth = 120" at
// 120 rather than 60 - and rounds <sound tempo> to a whole number. Playback
// needs neither, so the tempo comes from here: <sound tempo>, which MusicXML
// defines as quarter notes per minute, or else the metronome mark converted
// from its beat unit.

/** Each note value's length in quarter notes. */
const UNIT_QUARTERS = {
    maxima: 32,
    long: 16,
    breve: 8,
    whole: 4,
    half: 2,
    quarter: 1,
    eighth: 0.5,
    "16th": 0.25,
    "32nd": 0.125,
    "64th": 0.0625,
    "128th": 0.03125,
};

/** Positions closer than this, in whole notes, are the same position. */
const SAME_PLACE = 1e-6;

/**
 * Tempo changes by measure, as a Map from measure index (document order,
 * which is OSMD's SourceMeasures order) to `{ at, bpm }[]` sorted by `at`,
 * the position in the measure in whole notes. Every part is read, since a
 * tempo mark may be written in any of them; where two parts mark the same
 * place, <sound tempo> beats a printed mark, and otherwise the first part
 * wins. Returns null for anything that is not partwise MusicXML, so the
 * caller can fall back to OSMD's own reading.
 */
export function readTempoMap(xml) {
    let doc;
    try {
        doc = new DOMParser().parseFromString(xml, "application/xml");
    } catch {
        return null;
    }
    const parts = [...doc.getElementsByTagName("part")];
    if (doc.getElementsByTagName("parsererror").length || !parts.length) return null;

    const found = new Map();
    for (const part of parts) {
        let divisions = 1;
        [...part.children]
            .filter((child) => child.tagName === "measure")
            .forEach((measure, index) => {
                for (const event of readMeasure(measure, () => divisions, (d) => (divisions = d))) {
                    addEvent(found, index, event);
                }
            });
    }

    for (const events of found.values()) events.sort((a, b) => a.at - b.at);
    return found;
}

/** Keeps one event per position: <sound> over a printed mark, else the first. */
function addEvent(found, index, event) {
    const events = found.get(index) ?? [];
    const same = events.find((e) => Math.abs(e.at - event.at) < SAME_PLACE);
    if (!same) events.push(event);
    else if (event.fromSound && !same.fromSound) Object.assign(same, event);
    found.set(index, events);
}

/** The tempo events in one measure, walking its notes to know where they are. */
function readMeasure(measure, getDivisions, setDivisions) {
    const events = [];
    let position = 0; // in divisions
    const whole = (divisions) => divisions / (getDivisions() * 4);

    for (const child of measure.children) {
        switch (child.tagName) {
            case "attributes": {
                const divisions = Number(child.getElementsByTagName("divisions")[0]?.textContent);
                if (divisions > 0) setDivisions(divisions);
                break;
            }
            case "note": {
                // Chord tones share the first note's onset; grace notes take no time.
                if (has(child, "chord") || has(child, "grace")) break;
                position += durationOf(child);
                break;
            }
            case "backup":
                position -= durationOf(child);
                break;
            case "forward":
                position += durationOf(child);
                break;
            case "direction": {
                const offset = Number(direct(child, "offset")?.textContent) || 0;
                const bpm = tempoOfDirection(child);
                if (bpm) events.push({ at: whole(Math.max(position + offset, 0)), ...bpm });
                break;
            }
            case "sound": {
                const bpm = soundTempo(child);
                if (bpm) events.push({ at: whole(Math.max(position, 0)), bpm, fromSound: true });
                break;
            }
        }
    }
    return events;
}

/** A direction's tempo: its <sound tempo> if it has one, else its metronome mark. */
function tempoOfDirection(direction) {
    let printed = null;
    for (const type of direction.getElementsByTagName("direction-type")) {
        const metronome = direct(type, "metronome");
        printed = metronome && metronomeTempo(metronome);
        if (printed) break;
    }

    const sound = direct(direction, "sound");
    const fromSound = sound && soundTempo(sound);
    if (fromSound) {
        // A common slip, by people and by the photo reader alike: copying the
        // printed figure into <sound tempo> without converting it to quarter
        // notes, so "dotted quarter = 60" becomes tempo 60 instead of 90. A
        // sound tempo that is exactly the printed figure, under a beat unit
        // that is not a quarter, is that slip - the printed mark is right.
        const slip = printed && printed.perMinute === fromSound && printed.bpm !== fromSound;
        return { bpm: slip ? printed.bpm : fromSound, fromSound: true };
    }
    return printed ? { bpm: printed.bpm, fromSound: false } : null;
}

function soundTempo(sound) {
    const bpm = Number.parseFloat(sound.getAttribute("tempo"));
    return bpm > 0 && bpm < 1000 ? bpm : null;
}

/**
 * Quarter notes per minute from a printed mark like "dotted quarter = 60", as
 * `{ bpm, perMinute }` - the converted tempo and the figure as printed.
 * A mark relating two note values (a metric modulation) has no per-minute
 * figure, so it gives nothing.
 */
function metronomeTempo(metronome) {
    const units = [...metronome.children].filter((c) => c.tagName === "beat-unit");
    const perMinute = Number.parseFloat(
        /\d+(\.\d+)?/.exec(direct(metronome, "per-minute")?.textContent ?? "")?.[0],
    );
    if (units.length !== 1 || !(perMinute > 0)) return null;

    const quarters = UNIT_QUARTERS[units[0].textContent.trim()];
    if (!quarters) return null;

    // Dots belong to the beat unit they follow: one dot is x1.5, two x1.75.
    let dots = 0;
    for (let next = units[0].nextElementSibling; next?.tagName === "beat-unit-dot"; next = next.nextElementSibling) {
        dots += 1;
    }
    const bpm = perMinute * quarters * (2 - 1 / 2 ** dots);
    return bpm > 0 && bpm < 1000 ? { bpm, perMinute } : null;
}

function durationOf(element) {
    return Number(direct(element, "duration")?.textContent) || 0;
}

function has(element, tag) {
    return Boolean(direct(element, tag));
}

/** A direct child by tag name, not any descendant. */
function direct(element, tag) {
    return [...element.children].find((child) => child.tagName === tag) ?? null;
}
