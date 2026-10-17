// Checks that every measure of a MusicXML file adds up: for each voice, the
// durations must total divisions x beats, honouring <backup> and <forward>.
// This is the same rule the transcription prompt holds the model to, and the
// same check a reading gets (public/js/reader/measures.js).
//
//   node tools/check-musicxml.mjs samples/*.musicxml

import { readFileSync } from "node:fs";
import { checkMeasures } from "../public/js/reader/measures.js";

function fail(message) {
    console.error(message);
    process.exitCode = 1;
}

function checkFile(path) {
    const { measures, notes, divisions, uneven } = checkMeasures(readFileSync(path, "utf8"));
    for (const { measure, voice, total, expected } of uneven) {
        fail(`${path}: measure ${measure}, voice ${voice} totals ${total} but needs ${expected} (divisions=${divisions})`);
    }
    if (!divisions) fail(`${path}: no <divisions> found`);
    console.log(`${path}: ${measures} measures, ${notes} notes, divisions=${divisions}`);
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
    console.error("usage: node tools/check-musicxml.mjs <file.musicxml> ...");
    process.exit(2);
}
for (const path of paths) checkFile(path);
if (!process.exitCode) console.log("All measures add up.");
