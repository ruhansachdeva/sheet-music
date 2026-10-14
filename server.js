import express from "express";
import multer from "multer";
import {
    transcribe,
    refine,
    TranscribeError,
    currentProvider,
    requireProvider,
} from "./lib/transcriber.js";

const app = express();
const PORT = process.env.PORT || 3000;

const INSTRUMENTS = [
    "piano",
    "violin",
    "cello",
    "flute",
    "clarinet",
    "trumpet",
    "alto sax",
    "tenor sax",
    "guitar",
];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = file.mimetype === "application/pdf" || file.mimetype.startsWith("image/");
        cb(ok ? null : new TranscribeError("Only images and PDFs are sent to Claude.", 400), ok);
    },
});

app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));
app.use("/samples", express.static("samples"));

function readInstrument(body) {
    const instrument = String(body.instrument || "piano").toLowerCase();
    if (!INSTRUMENTS.includes(instrument)) {
        throw new TranscribeError(`Unknown instrument: ${instrument}`, 400);
    }
    return instrument;
}



/** A photo or PDF in, MusicXML plus any clarifying questions out. */
app.post("/api/transcribe", upload.single("file"), async (req, res, next) => {
    try {
        if (!req.file) throw new TranscribeError("No file uploaded.", 400);
        const instrument = readInstrument(req.body);
        requireProvider();

        const result = await transcribe({ file: req.file, instrument });
        logUsage("transcribe", req.file, result);
        res.json({ title: result.title, musicxml: result.musicxml, questions: result.questions });
    } catch (err) {
        next(err);
    }
});

/** The same file, the MusicXML so far and my answers in, a corrected score out. */
app.post("/api/refine", upload.single("file"), async (req, res, next) => {
    try {
        if (!req.file) throw new TranscribeError("No file uploaded.", 400);
        if (!req.body.musicxml) throw new TranscribeError("No musicxml to correct.", 400);
        const instrument = readInstrument(req.body);

        let answers;
        try {
            answers = JSON.parse(req.body.answers || "[]");
        } catch {
            throw new TranscribeError("answers was not valid JSON.", 400);
        }
        if (!Array.isArray(answers) || answers.length === 0) {
            throw new TranscribeError("No answers to apply.", 400);
        }
        requireProvider();

        const result = await refine({
            file: req.file,
            instrument,
            musicxml: req.body.musicxml,
            answers,
        });
        logUsage("refine", req.file, result);
        res.json({ title: result.title, musicxml: result.musicxml, questions: result.questions });
    } catch (err) {
        next(err);
    }
});

function logUsage(route, file, result) {
    const { input, output } = result.usage ?? {};
    console.log(
        `${route}: ${file.originalname} (${file.mimetype}) -> "${result.title}", ` +
            `${result.questions.length} question(s), ${input} in / ${output} out [${result.model}]`,
    );
}

// Everything that throws ends up here, so the browser always gets JSON.
app.use((err, _req, res, _next) => {
    const status = err.status ?? (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
    const message =
        err.code === "LIMIT_FILE_SIZE" ? "That file is larger than 25 MB." : err.message;

    // A missing key or a declined file is expected and explains itself; only an
    // unexpected failure is worth a stack trace.
    if (err instanceof TranscribeError) console.error(`${status}: ${message}`);
    else console.error(err);

    res.status(status).json({ error: message });
});

app.listen(PORT, () => {
    console.log(`Sheet music app running at http://localhost:${PORT}`);

    const provider = (() => {
        try {
            return currentProvider();
        } catch (error) {
            console.log(error.message);
            return null;
        }
    })();

    if (provider) console.log(`Reading photos and PDFs with ${provider.label}.`);
    else console.log("No API key set - MusicXML and MIDI still work, photos and PDFs will not.");
});
