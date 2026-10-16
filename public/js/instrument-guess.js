// Which of the picker's instruments a piece looks written for, from what it
// says about itself: its part and instrument names, a MIDI track's General
// MIDI instrument, and whether its notes are drum notes. Only a clear answer
// counts - a score for several instruments is no reason to second-guess the
// pick.

/** Names that say which instrument a part is for. Drums first: "Bass Drum". */
const NAMES = [
    [/drum|percussion|\bkit\b|snare|hi-?hat|cymbal|tom-tom/i, "drums"],
    [/double bass|contrabass|upright bass|string bass/i, "double bass"],
    [/bass guitar|electric bass|fretless|\bbass\b(?!\s*clarinet)/i, "bass"],
    [/alto sax/i, "alto sax"],
    [/tenor sax/i, "tenor sax"],
    [/clarinet/i, "clarinet"],
    [/trumpet|cornet/i, "trumpet"],
    [/flute/i, "flute"],
    [/violin|fiddle/i, "violin"],
    [/cello/i, "cello"],
    [/guitar/i, "guitar"],
    [/piano|keyboard/i, "piano"],
];

/** The instrument a name points to, or null. */
export function instrumentFromName(name) {
    if (/bass clarinet|piccolo|soprano sax|baritone sax|horn|viola/i.test(name ?? "")) {
        // Real instruments the picker does not have: no guess beats a wrong one.
        return null;
    }
    return NAMES.find(([pattern]) => pattern.test(name ?? ""))?.[1] ?? null;
}

/**
 * The instrument a piece looks written for, or null when it does not say
 * clearly. `names` are its part, instrument and track names; `drumShare` the
 * share of its notes that are drum notes.
 */
export function guessInstrument({ names = [], drumShare = 0 }) {
    // Every note a drum note is drum music, whatever the parts are called.
    if (drumShare >= 0.99) return "drums";

    const guesses = new Set(names.map(instrumentFromName).filter(Boolean));
    // Drums named but hardly any drum notes, or the other way round: mixed.
    if (drumShare > 0 && !guesses.has("drums")) return null;
    return guesses.size === 1 ? [...guesses][0] : null;
}
