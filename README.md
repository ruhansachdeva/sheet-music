# Sheet Music Player

Upload any sheet music, pick an instrument, and play it back with correct timing.

## Planned features

- **Upload**: MusicXML (`.musicxml`, `.xml`, `.mxl`) and MIDI load directly. Photos and PDFs are read by Claude, which asks clarifying questions when something is unclear (for example, "is this a tie?").
- **Instrument picker**: changes the playback sound.
- **Accurate timing**: ties, dots, tuplets and tempo handled correctly.
- **Metronome**: separate toggles for a count-in and for clicking during playback.
- **Highlighting**: the note on the current beat lights up as it plays.

## Setup

```
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm start
```

Then open http://localhost:3000
