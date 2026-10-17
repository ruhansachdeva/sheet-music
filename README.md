# Sheet Music Player

**NOTE: This is a personal site for the time being; I may expand it later on, but for now it is just an open-source personal project. To run it, you will need to fork this repo.**

**[Try it live →](https://ruhansachdeva.github.io/sheet-music/)**

Upload any sheet music, pick an instrument, and play it back with correct timing,
a metronome, and the current note lit up on the score.

> The live site is static files on GitHub Pages: it plays MusicXML and MIDI,
> writes scores, runs the metronome and highlights notes. To read photos and
> PDFs there too, paste your own free Gemini API key into the page once on each
> device - it stays in that browser and is only ever sent to Google. Running it
> locally with a key in `.env`, as below, works without that.

- **MusicXML** (`.musicxml`, `.xml`, `.mxl`) and **MIDI** (`.mid`, `.midi`) load
  straight in the browser.
- **Photos, scans, SVG pages and PDFs** are read into MusicXML for you, with a
  question asked when something on the page is genuinely ambiguous. Choose
  several photos at once - each page of a piece - and they are read together
  into one score.
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
- **Controls**: play/pause (or the space bar), stop, a seek bar with the time
  played and the length of the piece - slide it anywhere, and the highlighted
  notes follow - a tempo slider that starts at the score's own tempo, a size
  slider, and the bar you are currently on. The score scrolls to keep the
  highlighted notes in view.

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

Reading is done by `gemini-flash-latest`. The free tier shares capacity, so
Flash is sometimes too busy to answer, often for minutes at a time: the
provider keeps asking for up to five minutes, as often as Google allows, before
saying so. The free tier also allows 20 readings a day, reset at midnight
Pacific; once they are used, the page says when they come back rather than
waiting.

There is deliberately no automatic fallback to `gemini-flash-lite-latest`.
Measured on the accuracy samples, Flash-Lite got 0-14% of pitches right,
against about 90% for Flash - a reading that wrong is worse than none. If you
want one anyway, list it: `GEMINI_MODEL=gemini-flash-latest,gemini-flash-lite-latest`,
and the page will say when the lighter model did the reading.
Optional overrides, none of them usually needed:

| Variable | Default | Why you might change it |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-flash-latest` | Use another model, or list several, comma-separated, to fall through when one is busy or out of requests. The error message lists what your key can reach. |
| `GEMINI_THINKING` | `medium` | Thinking tokens come out of the output budget - at `high` the model can spend the lot thinking and return nothing. |
| `GEMINI_MAX_OUTPUT_TOKENS` | `65536` | Flash's maximum. Thinking comes out of it: at 32768, Flash thought for 31,456 tokens over one page of Twinkle and the score came back cut off. |
| `GEMINI_BUSY_PATIENCE_MS` | `300000` | How long to wait for a busy model before giving up on it. |
| `GEMINI_API_BASE` | Google's v1beta endpoint | Send requests through a proxy. |

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
it back. Tempo is always shown in quarter notes a minute, so a piece marked
"half = 60" shows 120 BPM, and "dotted quarter = 60" in 6/8 shows 90. A MIDI
file with no tempo of its own plays at the MIDI standard's 120.

**Instruments and transposition** — load *Twinkle* and switch between piano,
violin and flute: same notes, different sound. Switch to clarinet and the
playback drops a tone (written pitch to concert pitch), as it should: -2
semitones for clarinet and trumpet, -9 for alto sax, -14 for tenor sax, -12 for
guitar, bass guitar and double bass. A part whose MusicXML states its own
transposition (`<transpose>`, as exported parts for clarinet, horn and the like
do) plays at that instead, whichever instrument you pick to hear it on, and the
status line says so.

**Checking the instrument** — the instrument you pick sets the sound and the
transposition, so when a piece looks written for another one, the page asks:
pick Flute and load *Drum groove*, and it says "This looks like drum music, but
Flute is picked", with *Play it as Drums* and *Keep Flute*. It goes by what a
photo's reader says the page is for, or by a file's part and instrument names
and how many of its notes are drums, or by a MIDI file's track instruments - and
only asks when the answer is clear: a score for several instruments, or your own
written one, is left alone.

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

**On a laptop** — the writer takes the keyboard: A–G for notes, ↑ ↓ for the
octave, 1 2 4 8 6 for whole to sixteenth (the fraction of a whole note), `.`
for a dot, R for a rest, S for chord, Backspace to undo or delete, Esc to stop
editing a note.

**Fixing a note** — with the writer open, tap it on the score, or tap its chip
in the strip above the note values; either selects it, and it lights up on the
score. A tap only has to land near a note.

**Going to a note** — on any score, tap a note and the music pauses there,
highlighted, so Play carries on from it. Inside a repeat it goes to the pass
nearest where you are. Then a key
replaces its pitch, a note value changes its length, **Rest** turns it into a
rest, and **Delete** removes it. **Done editing** goes back to adding at the
end.

**Triplets** — press **3** beside the dot, and the notes you write are triplets
of the chosen value: three in the time of two, drawn under a bracket. Press it
again to go back. It works on a selected note too, and `3` on a keyboard.

**Chords** — press **Chord**, then tap the notes that sound together: the first
starts a new chord at the chosen length, and each one after it joins that chord
rather than following it. **Next chord** finishes that chord and starts
another, so a progression is Chord, C E G, Next chord, F A C, and so on. Press
**Chord** again to go back to writing one note at a time. A line under the
buttons always says what a tap will do. To add a note to a chord already
written, select it and turn on Chord. It works on the kit too, for a kick and
a hi-hat on the same beat.

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

Keyboard: space plays and pauses - except on a button you have moved to with
Tab, which it presses, as it does on any web page. The instrument you pick is remembered for next
time.

## Automated checks

```sh
npm run check            # every measure in samples/ adds up to its time signature
npm test                 # drives the app in headless Chrome
npm run test:audio       # also plays, and watches the audio clock and cursor
npm run test:editor      # the note writer's model and MusicXML output
npm run test:provider    # how a busy Gemini is handled, against a local fake
npm run test:reader      # how a reading is joined, checked and put right, with fake answers
npm run test:read-flow   # photo -> reading -> question -> answer, against a local fake,
                         # through the server and on the hosted copy with your own key
npm run test:transcribe  # end to end through the model - needs a key
npm run test:accuracy    # how accurately a page is read back - needs a key
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

`npm run test:accuracy` answers a different question from the rest: not "is the
output valid" but "is it the same music". It renders a sample whose notes are
known exactly, photographs the engraving, reads the picture back, and diffs the
result note by note - pitches, onsets and lengths, counted in beats so that a
tempo misread does not look like every note being wrong. It prints the first
few disagreements, so a failure tells you which notes were misread rather than
just that something was.

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
lib/transcriber.js   picks a provider and runs the reading through it
lib/providers/       one file per provider: gemini.js, claude.js
public/js/reader/    reading a page, shared by the server and the hosted page:
                     prompt.js, read.js (carrying on, filling, rechecking),
                     measures.js (the bar checks), gemini.js (the client)
public/js/photo.js   gets a photo, SVG or PDF ready, and cuts it into strips
public/js/strips.js  where a page can be cut: the blank paper between systems
public/js/wake.js    keeps a phone's screen on while a reading runs
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
own iterator, which unrolls repeats, and records three things in one pass: note
events, the cursor positions for highlighting, and a metronome beat grid. Times
are in *reference seconds* - seconds at the score's own tempo - so the tempo
slider is one multiplier applied at playback, and scores that change tempo
part-way through still scale correctly.

The tempo itself comes from `tempo.js`, which reads it straight from the
MusicXML rather than from OSMD: OSMD takes a printed "half = 60" as 60 quarter
notes a minute instead of 120, and rounds 62.5 to 63. `tempo.js` uses
`<sound tempo>` where a score has it, converts the printed metronome mark where
it does not, and places each change where it falls in the bar, so the notes and
the clicks both follow a change mid-bar. A `.mxl` file is unzipped to text
first, so it goes through the same path. A tied note is
emitted once at its start note for the whole tied length, so it sounds as one
held note.

**Playing it.** Everything audible is scheduled on the Web Audio clock. A timer
wakes up every 25 ms, looks 150 ms ahead, and hands each event in that window to
the audio graph with an exact start time, so the timing does not drift when the
main thread is busy. Nothing is played by `setTimeout`. The highlighting runs off
`requestAnimationFrame` and reads the same audio clock, so what you see and what
you hear stay together.

**Reading a photo.** The page gets the picture ready before it leaves the
phone: turned upright, scaled to 2400 px, an SVG drawn as a PNG, and each page
of a PDF (up to eight) drawn with pdf.js. Then it is **cut into strips** between
its systems, where the paper is blank. A model sees an image through a fixed
number of tokens however big it is, so a dense page sent whole is squeezed
until noteheads and dots blur: on a page of sixteenth-note drums, reading it
whole got about a third of the hits right; in strips of a system or two, each
sent at full resolution, about four in five. The strips all go in one request.

The reader gets a strict JSON schema for its answer and is asked for complete,
compact MusicXML 3.1 at written pitch - no layout the player redoes itself, so
a full page fits in one answer. Claude gets adaptive thinking and
`effort: "high"`; Gemini gets `thinking_level: "medium"` over its REST
Interactions API. Then the reading is put together and checked, in
`public/js/reader/read.js`:

- **Out of room:** if the answer is cut off, every finished bar is kept and the
  model carries on from the next one, up to four times.
- **Skipped bars:** bar numbers have to run 1, 2, 3…; any missing are asked for
  by number and put in their place.
- **Bars that don't add up:** every voice of every bar is checked against the
  time signature, and those that are off go back to the model with what they
  total and need. A corrected bar goes in only if it now adds up without
  upsetting another.

Anything still wrong is named on screen, so you know which bars to check.
Questions are asked only when a reading is genuinely ambiguous and the answer
changes the notes or the timing.

Libraries come from jsDelivr, so there is no build step:
[opensheetmusicdisplay](https://opensheetmusicdisplay.org/) 2.2.1 for the score
and its cursor, [smplr](https://github.com/danigb/smplr) 1.1.0 for soundfont
instruments and the drum machine, and
[@tonejs/midi](https://github.com/Tonejs/Midi) 2.0.28 for MIDI files.

## The hosted site

Every push to `main` publishes `public/` and `samples/` to GitHub Pages through
[`.github/workflows/pages.yml`](.github/workflows/pages.yml), after the sample,
note-writer and provider checks pass. Nothing secret goes near it.

There is no server there, so to read photos the page offers to take your own
Gemini key from [Google AI Studio](https://aistudio.google.com/apikey). It checks
the key with Google (listing models, which costs no readings), keeps it in that
browser's storage, and from then on reads photos and PDFs in the page itself -
the same prompts, client and checks the server uses, from `public/js/reader/`.
**Forget it** removes the key. Since it lives in the browser, use it on your own
devices, not shared ones.

Reads are streamed. One takes one to four minutes - a dense page more - and a
phone's browser drops a request that stays silent for about a minute, so the
model streams summaries of its thinking as it goes: data arrives every few
seconds, and the status line shows what it is working on ("Defining the Measure
Structure"), and when it is carrying on, filling skipped bars or rechecking.
The screen is kept on while it reads, since a locked phone suspends the page
and would drop the reading. Requests are sent with `store: false`, so Google
keeps nothing once the read is done.

## On a phone

The layout is built mobile first. The transport docks to the bottom of the
screen in thumb reach, with tempo, metronome and size behind a **More** button;
the loading controls fold away once music is on screen; the score is engraved to
fit the width, and re-fits when you turn the phone. Part names and the in-score
title are dropped on narrow screens, since the page shows the title anyway and
both of them overflowed a small screen.

## Known limits

- Up to 12 photos, or a PDF of up to eight pages, are read in strips; a longer
  PDF is sent whole, and reads less accurately.
- Drum noteheads are sometimes put on the wrong line even in strips - the
  sound is usually right, the exact cymbal less so. Check a reading against
  the page.
- Instrument samples download on first use, so the first Play after switching
  instrument can wait a moment.
- Gemini's free tier is rate limited to a few requests a minute with a daily
  cap, so a long session of reading pages will hit a 429 and have to wait.
- Drum notation without a `<midi-unpitched>` mapping falls back to reading the
  staff position, using the common drum-notation convention; an unusual drum map
  can land on the wrong kit piece.
