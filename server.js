import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));

// TODO: POST /api/transcribe - send an uploaded photo/PDF to Claude, get MusicXML
// back plus any clarifying questions (e.g. "is this a tie?")

app.listen(PORT, () => {
    console.log(`Sheet music app running at http://localhost:${PORT}`);
});
