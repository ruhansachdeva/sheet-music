// Checks that every measure of a MusicXML file adds up: for each voice, the
// durations must total divisions x beats, honouring <backup> and <forward>.
// This is the same rule the transcription prompt holds Claude to.
//
//   node tools/check-musicxml.mjs samples/*.musicxml

import { readFileSync } from "node:fs";

function fail(message) {
    console.error(message);
    process.exitCode = 1;
}

/** A tag-level walk: enough to total durations without pulling in a parser. */
function* elements(xml) {
    const pattern = /<(\/?)([a-zA-Z-]+)([^>]*?)(\/?)>|<!--[\s\S]*?-->/g;
    let match;
    while ((match = pattern.exec(xml)) !== null) {
        if (match[0].startsWith("<!--")) continue;
        yield {
            close: match[1] === "/",
            name: match[2],
            attrs: match[3],
            selfClosing: match[4] === "/",
            index: match.index + match[0].length,
        };
    }
}

function textAfter(xml, index) {
    const end = xml.indexOf("<", index);
    return xml.slice(index, end === -1 ? undefined : end).trim();
}

function checkFile(path) {
    const xml = readFileSync(path, "utf8");

    let divisions = null;
    let beats = null;
    let beatType = null;
    let measureNumber = null;
    let voice = "1";
    let position = 0; // divisions from the start of the measure
    let perVoice = new Map();
    let isChord = false;
    let pendingDuration = 0;
    let measures = 0;
    let notes = 0;

    const finishMeasure = () => {
        if (measureNumber === null) return;
        const expected = (divisions * 4 * beats) / beatType;
        for (const [name, end] of perVoice) {
            if (Math.abs(end - expected) > 1e-6) {
                fail(
                    `${path}: measure ${measureNumber}, voice ${name} totals ${end} ` +
                        `but ${beats}/${beatType} with divisions=${divisions} needs ${expected}`,
                );
            }
        }
        measures += 1;
    };

    for (const element of elements(xml)) {
        const { name, close, index } = element;

        if (name === "divisions" && !close) divisions = Number(textAfter(xml, index));
        else if (name === "beats" && !close) beats = Number(textAfter(xml, index));
        else if (name === "beat-type" && !close) beatType = Number(textAfter(xml, index));
        else if (name === "measure" && !close) {
            finishMeasure();
            measureNumber = /number="([^"]+)"/.exec(element.attrs)?.[1] ?? "?";
            position = 0;
            voice = "1";
            perVoice = new Map();
        } else if (name === "note" && !close) {
            isChord = false;
            pendingDuration = 0;
            notes += 1;
        } else if (name === "chord" && !close) isChord = true;
        else if (name === "duration" && !close) pendingDuration = Number(textAfter(xml, index));
        else if (name === "voice" && !close) voice = textAfter(xml, index);
        else if (name === "note" && close) {
            // A chord note sounds with the previous note, so it adds no time.
            if (!isChord) position += pendingDuration;
            perVoice.set(voice, Math.max(perVoice.get(voice) ?? 0, position));
        } else if (name === "backup" && close) {
            position -= pendingDuration;
        } else if (name === "forward" && close) {
            position += pendingDuration;
            perVoice.set(voice, Math.max(perVoice.get(voice) ?? 0, position));
        }
    }
    finishMeasure();

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
