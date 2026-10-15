# Sheet Music Player

**[Try it live →](https://ruhansachdeva.github.io/sheet-music/)**

Upload any sheet music, pick an instrument, and play it back with correct timing,
a metronome, and the current note lit up on the score.

> The live site is static files on GitHub Pages, so it plays MusicXML and MIDI,
> writes scores, runs the metronome and highlights notes - everything that runs
> in the browser. Reading a photo or a PDF needs the server and an API key, so
> for that, run it locally as below. The page tells you which copy you are on.

- **MusicXML** (`.musicxml`, `.xml`, `.mxl`) and **MIDI** (`.mid`, `.midi`) load
  straight in the browser.
- **Photos and PDFs** are read into MusicXML for you, with a question asked when
  something on the page is genuinely ambiguous.
- **Take a photo** on a phone: the camera button opens the rear camera, so you
  can point it at a page and have it played back.
- **Write it yourself**: a note writer with a piano keyboard, note values, rests,
  dots and undo, which engraves and plays as you write.
- **Instruments**: piano, violin, cello, flute, clarinet, trumpet, alto sax,
  tenor sax, guitar, bass guitar, double bass, drums.
- **Timing**: tempo, time signatures, dotted notes, ties, triplets and other
  tuplets, rests, repeats, and several voices or staves at once.
- **Metronome**: separate count-in and during-playback toggles, accented on
  beat 1, clicking on the time signature's beat.
- **Controls**: play/pause (or the space bar), stop, a tempo slider that starts
  at the score's own tempo, a size slider, and the bar you are currently on.

## Run it

```sh
npm install
cp .env.example .env     # add an API key
npm start
```

Then open <http://localhost:3000>.

A key is only needed for reading photos and PDFs. Without one the app still
loads MusicXML and MIDI, and says so on startup. The key stays on the server:
the browser only ever talks to `/api/transcribe` and `/api/refine`.

### Which key

Two providers are built in, and the app uses whichever key you set:

| Provider | Key | Cost | Notes |
| --- | --- | --- | --- |
| **Gemini** | `GEMINI_API_KEY` from [AI Studio](https://aistudio.google.com/apikey) | Free tier | Reads images and PDFs natively. A few requests a minute, resets daily. |
| **Claude** | `ANTHROPIC_API_KEY` from the [Console](https://console.anthropic.com/settings/keys) | Paid credits | Better at dense or handwritten scores, roughly $0.20-0.50 a page. |

Set both and Gemini wins; `PROVIDER=claude` in `.env` forces the other.

Gemini's free tier shares capacity, so a model is sometimes too busy to answer.
The provider handles that itself: it retries with backoff, then falls through
from `gemini-flash-latest` to `gemini-flash-lite-latest`. Three optional
overrides, none of them usually needed:

| Variable | Default | Why you might change it |
| --- | --- | --- |
| `GEMINI_MODEL` | the two above, in order | Pin one model. The error message lists what your key can reach. |
| `GEMINI_THINKING` | `medium` | Thinking tokens come out of the output budget - at `high` the model can spend the lot thinking and return nothing. |
| `GEMINI_MAX_OUTPUT_TOKENS` | `32768` | Raise it for very dense pages. |

## Testing each feature

The four files in `samples/` cover everything without needing a key.

**Score rendering and playback** — click *Twinkle (piano)*, then Play. Two staves
play together, the notes under the cursor turn orange, and the page follows the
cursor.

**Timing** — click *Timing test*. It is built to be checked by ear against the
score:

| Bar | What to listen for |
| --- | --- |
| 1 | A dotted quarter, then a short eighth, then a quarter, then a bar of silence for the rest |
| 2 | Three even triplet eighths inside one beat, then a quarter, then a half |
| 3-4 | The F at the end of bar 3 is tied over the barline: one held note lasting a whole note, not two |
| 1-4 again | The repeat jumps back and plays bars 1-4 a second time |
| 5-6 | 6/8: six eighths, then two dotted quarters |

**Metronome and count-in** — with *Timing test* loaded, tick **Count in** and
press Play: four clicks, accented on the first, before the music. Tick
**Metronome** and listen through to bar 5, where the click changes to six
eighth-note clicks per bar because the time signature does.

**Tempo** — the slider starts at the score's own tempo (96 BPM for the timing
test, 100 if a score has no marking). Drag it while the music plays; it speeds up
without losing its place, and the metronome follows. *Reset to score tempo* puts
it back.

**Instruments and transposition** — load *Twinkle* and switch between piano,
violin and flute: same notes, different sound. Switch to clarinet and the
playback drops a tone (written pitch to concert pitch), as it should: -2
semitones for clarinet and trumpet, -9 for alto sax, -14 for tenor sax, -12 for
guitar, bass guitar and double bass.

**Drums** — click *Drum groove*. The notes on the percussion staff are read
through the score's own `<midi-unpitched>` mapping, so the kick, snare, hi-hat
and crash each play their own sound. Picking **Drums** in the instrument list
plays any score through the kit.

**MIDI** — click *MIDI groove*. MIDI has no notation, so it shows as a piano roll
with the sounding notes lit and a playhead. The file has a melody on channel 1
and a kit on channel 10; the channel-10 track plays as drums whichever
instrument is picked. MIDI is already at concert pitch, so it is never
transposed.

**Uploading** — use the file picker, or drop a file anywhere on the page. On a
phone there is a **Take a photo** button as well, which opens the rear camera
directly rather than the photo library. It only appears on devices that have a
camera.

**Chords** — press **Stack**, then tap the notes that belong together: each one
joins the note before it rather than following it. Press it again to go back to
writing one note at a time. It works on the kit too, for a kick and a hi-hat on
the same beat.

**Writing drums** — pick **Drums** before pressing **Write it yourself**, and
the keyboard becomes the kit: hi-hat, open hat, ride, crash, three toms, snare
and kick. It writes unpitched notes on a percussion staff with cross noteheads
for the cymbals, so it looks like drum notation and plays through the kit.

**Writing a score** — press **Write it yourself**. Pick a note value, then tap
keys to add notes; each one sounds as you add it, and the score re-engraves
underneath. **Rest** adds a rest of the chosen value, **Undo** steps back
(50 deep) and **Clear** starts again. The title, time signature, tempo and clef
are along the top. Press **Done** when finished, and **Edit notes** beside the
title to go back in. Notes that run past a bar line are split and tied for you.

**Photos and PDFs** (needs a key) — upload a photo of a page, or a PDF. Pick the
instrument first: it is passed to Claude as context. Claude returns MusicXML plus
any questions, the score renders, and it plays immediately.

**Clarifying questions** (needs a key) — when Claude is unsure, a panel appears
above the score. Each question has buttons for its suggested answers, a free-text
box, and *Skip*. Answer what you know, press *Send answers to Claude*, and the
corrected score replaces the old one. Skipped questions keep Claude's best guess.
*Skip all* dismisses the panel and keeps the score you already have.

**Keeping a transcription** — *Download MusicXML* next to the title saves what
is on screen. Worth doing after Claude reads a photo: that transcription is
otherwise gone on reload.

**Size** — the *Size* slider re-engraves the score between 50% and 200%, keeping
the cursor where it was. It stretches the piano roll instead for a MIDI file.

Keyboard: space plays and pauses. The instrument you pick is remembered for next
time.

## Automated checks

```sh
npm run check            # every measure in samples/ adds up to its time signature
npm test                 # drives the app in headless Chrome
npm run test:audio       # also plays, and watches the audio clock and cursor
npm run test:editor      # the note writer's model and MusicXML output
npm run test:transcribe  # end to end through the model - needs a key
```

`npm test` is the useful one. It drives a real browser over the DevTools
protocol and asserts on the timeline the timing engine produces: that a dotted
quarter is 1.5 beats, that six triplet eighths are a third of a beat each, that
the tied F is one note of a whole note's length, that the repeat unrolls into a
second pass, that 6/8 produces six clicks a bar, that drum notes map to the right
kit pieces, and that the engraving is laid out at a sensible size. It also writes
a score through the note writer's own interface, and answers a set of clarifying
questions. It needs a Chromium binary — it finds Playwright's cached one, or set
`CHROME_PATH`.

`npm run test:editor` checks the writer's model directly in Node: that lengths
decompose into writable note values, that notes crossing a bar line are split
and tied, and that the MusicXML it produces passes the same measure-duration
check as the samples.

`npm run test:transcribe` has no photograph to work from, so it renders a sample in
the browser, screenshots the engraving, and posts that image to
`/api/transcribe` as if you had photographed it. It then checks the MusicXML that
comes back renders, plays, and has measures that add up. Add `-- --answer` to
answer every question with its first option and exercise `/api/refine` too. On
Gemini's free tier this costs nothing to run.

## How it works

```text
server.js            Express: POST /api/transcribe, POST /api/refine
lib/transcriber.js   picks a provider, validates what comes back
lib/prompt.js        the prompt and response schema, shared by both providers
lib/providers/       one file per provider: gemini.js, claude.js
public/app.js        picks a loader for the file, wires up the controls
public/js/score.js   renders MusicXML, reads a timeline out of it
public/js/midi.js    parses MIDI, draws the piano roll
public/js/player.js  the audio clock, scheduler and metronome
public/js/drums.js   General MIDI percussion keys to drum machine sounds
public/js/questions.js  the clarifying-question panel
public/js/editor/       writing a score by hand: model.js and ui.js
tools/               the checks above, and the MIDI sample generator
```

**Reading the score.** `score.js` walks the score with OpenSheetMusicDisplay's
own iterator, which unrolls repeats and follows tempo changes, and records three
things in one pass: note events, the cursor positions for highlighting, and a
metronome beat grid. Times are in *reference seconds* - seconds at the score's
own tempo - so the tempo slider is one multiplier applied at playback, and
scores that change tempo part-way through still scale correctly. A tied note is
emitted once at its start note for the whole tied length, so it sounds as one
held note.

**Playing it.** Everything audible is scheduled on the Web Audio clock. A timer
wakes up every 25 ms, looks 150 ms ahead, and hands each event in that window to
the audio graph with an exact start time, so the timing does not drift when the
main thread is busy. Nothing is played by `setTimeout`. The highlighting runs off
`requestAnimationFrame` and reads the same audio clock, so what you see and what
you hear stay together.

**Reading a photo.** The image or PDF goes to whichever provider is configured,
with a strict JSON schema for the response. Claude gets adaptive thinking and
`effort: "high"`, streamed because a full score of MusicXML is long, with
server-side refusal fallbacks on; Gemini gets `thinking_level: "high"` over its
REST Interactions API, which takes PDFs natively so a scan never has to be
rendered to images. The prompt asks for complete MusicXML 3.1
at written pitch, and is strict about the thing that breaks playback most often:
every measure's durations have to add up to the time signature. Questions are
asked only when a reading is genuinely ambiguous and the answer changes the notes
or the timing.

Libraries come from jsDelivr, so there is no build step:
[opensheetmusicdisplay](https://opensheetmusicdisplay.org/) 2.2.1 for the score
and its cursor, [smplr](https://github.com/danigb/smplr) 1.1.0 for soundfont
instruments and the drum machine, and
[@tonejs/midi](https://github.com/Tonejs/Midi) 2.0.28 for MIDI files.

## The hosted site

Every push to `main` publishes `public/` and `samples/` to GitHub Pages through
[`.github/workflows/pages.yml`](.github/workflows/pages.yml), after the sample
and note-writer checks pass. Nothing secret goes near it: the API key lives only
in your local `.env`, never in the browser bundle, which is exactly why reading
photos cannot work there.

## On a phone

The layout is built mobile first. The transport docks to the bottom of the
screen in thumb reach, with tempo, metronome and size behind a **More** button;
the loading controls fold away once music is on screen; the score is engraved to
fit the width, and re-fits when you turn the phone. Part names and the in-score
title are dropped on narrow screens, since the page shows the title anyway and
both of them overflowed a small screen.

## Known limits

- One file at a time, so a multi-page PDF works but several photos of one piece
  do not; upload them one page at a time.
- Instrument samples download on first use, so the first Play after switching
  instrument can wait a moment.
- Gemini's free tier is rate limited to a few requests a minute with a daily
  cap, so a long session of reading pages will hit a 429 and have to wait.
- A tempo change in the middle of a measure moves the notes correctly but leaves
  that measure's remaining metronome clicks at the old tempo.
- Drum notation without a `<midi-unpitched>` mapping falls back to reading the
  staff position, using the common drum-notation convention; an unusual drum map
  can land on the wrong kit piece.
