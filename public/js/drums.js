// Drums are played by name, not by pitch: smplr's drum machines expose groups
// like "kick" and "hihat-close", and the names differ between machines. So a
// drum note travels as a General MIDI percussion key, and gets resolved to
// whichever group name the loaded machine actually has.

export const DRUM_MACHINE = "TR-808";

/**
 * General MIDI percussion key -> drum machine group names, best first. The
 * first name the loaded machine has wins.
 */
const GM_DRUM_GROUPS = {
    35: ["kick"], // acoustic bass drum
    36: ["kick"], // bass drum 1
    37: ["rimshot", "rim", "snare"], // side stick
    38: ["snare"], // acoustic snare
    39: ["clap", "snare"], // hand clap
    40: ["snare"], // electric snare
    41: ["tom-low", "low-tom", "conga-low"], // low floor tom
    42: ["hihat-close", "hihat-closed", "hihat"], // closed hi-hat
    43: ["tom-low", "low-tom", "conga-low"], // high floor tom
    44: ["hihat-close", "hihat-closed", "hihat"], // pedal hi-hat
    45: ["mid-tom", "tom-mid", "conga-mid"], // low tom
    46: ["hihat-open", "hihat"], // open hi-hat
    47: ["mid-tom", "tom-mid", "conga-mid"], // low-mid tom
    48: ["tom-hi", "tom-high", "hi-tom"], // hi-mid tom
    49: ["crash", "cymbal"], // crash cymbal 1
    50: ["tom-hi", "tom-high", "hi-tom"], // high tom
    51: ["ride", "cymbal"], // ride cymbal 1
    52: ["cymbal", "crash"], // china cymbal
    53: ["ride", "cymbal"], // ride bell
    54: ["maraca", "tambourine", "clap"], // tambourine
    55: ["cymbal", "crash"], // splash cymbal
    56: ["cowbell"], // cowbell
    57: ["crash", "cymbal"], // crash cymbal 2
    58: ["maraca", "clave"], // vibraslap
    59: ["ride", "cymbal"], // ride cymbal 2
    60: ["conga-hi", "tom-hi"], // hi bongo
    61: ["conga-low", "tom-low"], // low bongo
    62: ["conga-hi", "conga-mid"], // mute hi conga
    63: ["conga-hi", "conga-mid"], // open hi conga
    64: ["conga-low"], // low conga
    65: ["tom-hi"], // high timbale
    66: ["tom-low"], // low timbale
    69: ["maraca"], // cabasa
    70: ["maraca"], // maracas
    75: ["clave"], // claves
    76: ["clave", "rimshot"], // hi wood block
    77: ["clave", "rimshot"], // low wood block
};

/**
 * Where drum notes sit on a five-line percussion staff, as treble-clef pitches,
 * for scores that notate drums without a `<midi-unpitched>` mapping. This is
 * the common drum-notation convention (MuseScore / Guitar Pro style).
 */
const STAFF_POSITION_TO_GM = {
    62: 44, // D4  below staff - hi-hat pedal
    65: 36, // F4  bottom space - bass drum
    67: 41, // G4  - low floor tom
    69: 45, // A4  - low tom
    71: 47, // B4  middle line - mid tom
    72: 38, // C5  - snare
    74: 48, // D5  - hi-mid tom
    76: 50, // E5  - high tom
    77: 51, // F5  top line - ride
    79: 42, // G5  above staff - closed hi-hat
    81: 49, // A5  - crash
    82: 46, // Bb5 - open hi-hat
    83: 46, // B5  - open hi-hat
};

/** Turns a notated staff position into a drum sound, for unmapped drum staves. */
export function gmKeyFromStaffPosition(midi) {
    if (STAFF_POSITION_TO_GM[midi]) return STAFF_POSITION_TO_GM[midi];

    // Off the map: anything low is a drum, anything high is a cymbal.
    if (midi <= 64) return 36;
    if (midi >= 79) return 42;
    return 38;
}

/**
 * Picks the group name to play for a GM key, given the names this machine has.
 * Falls back to a snare, then to whatever the machine offers first, so a note
 * always makes a sound.
 */
export function resolveDrumName(gmKey, availableNames) {
    const available = new Set(availableNames);
    for (const candidate of GM_DRUM_GROUPS[gmKey] ?? []) {
        if (available.has(candidate)) return candidate;
    }
    for (const fallback of ["snare", "kick"]) {
        if (available.has(fallback)) return fallback;
    }
    return availableNames[0];
}
