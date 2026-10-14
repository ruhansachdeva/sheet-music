// The instrument list: the soundfont that plays it, and how far its written
// pitch sits from concert pitch. Playback adds `transpose` to every written
// note, so a clarinet's written C sounds as a Bb.
export const INSTRUMENTS = {
    piano: { label: "Piano", soundfont: "acoustic_grand_piano", transpose: 0 },
    violin: { label: "Violin", soundfont: "violin", transpose: 0 },
    cello: { label: "Cello", soundfont: "cello", transpose: 0 },
    flute: { label: "Flute", soundfont: "flute", transpose: 0 },
    clarinet: { label: "Clarinet (Bb)", soundfont: "clarinet", transpose: -2 },
    trumpet: { label: "Trumpet (Bb)", soundfont: "trumpet", transpose: -2 },
    "alto sax": { label: "Alto sax (Eb)", soundfont: "alto_sax", transpose: -9 },
    "tenor sax": { label: "Tenor sax (Bb)", soundfont: "tenor_sax", transpose: -14 },
    guitar: { label: "Guitar", soundfont: "acoustic_guitar_nylon", transpose: -12 },
};

export const DEFAULT_INSTRUMENT = "piano";
