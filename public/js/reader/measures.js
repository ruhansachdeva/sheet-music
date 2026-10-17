// Whether every measure of a MusicXML score adds up: for each voice, the
// durations must total divisions x beats, honouring <backup> and <forward>.
// The prompt holds the model to this rule; this is how a reading is checked
// against it, and how tools/check-musicxml.mjs checks the samples.
//
// A tag-level walk rather than a parser, so it runs the same in Node and in
// the page.

/** Every opening, closing and empty tag, with where its content starts. */
function* elements(xml) {
    const pattern = /<(\/?)([a-zA-Z-]+)([^>]*?)(\/?)>|<!--[\s\S]*?-->/g;
    let match;
    while ((match = pattern.exec(xml)) !== null) {
        if (match[0].startsWith("<!--")) continue;
        yield {
            close: match[1] === "/",
            name: match[2],
            attrs: match[3],
            index: match.index + match[0].length,
        };
    }
}

function textAfter(xml, index) {
    const end = xml.indexOf("<", index);
    return xml.slice(index, end === -1 ? undefined : end).trim();
}

/** "3+2" is five beats, as a compound signature writes it. */
function beatsOf(text) {
    return text.split("+").reduce((sum, part) => sum + Number(part), 0);
}

/**
 * Reads a score's measures. Returns how many measures and notes it has, its
 * divisions, and `uneven`: every voice of every measure that does not add up,
 * as { part, measure, voice, total, expected }. A pickup bar marked
 * implicit="yes" is short on purpose and is not counted as uneven.
 */
export function checkMeasures(xml) {
    let part = "";
    let divisions = null;
    let beats = null;
    let beatType = null;
    let measure = null;
    let implicit = false;
    let voice = "1";
    let position = 0; // divisions from the start of the measure
    let perVoice = new Map();
    let isChord = false;
    let pendingDuration = 0;
    let measures = 0;
    let notes = 0;
    const uneven = [];

    const finishMeasure = () => {
        if (measure === null) return;
        const expected = (divisions * 4 * beats) / beatType;
        if (!implicit) {
            for (const [name, total] of perVoice) {
                if (Math.abs(total - expected) > 1e-6) uneven.push({ part, measure, voice: name, total, expected });
            }
        }
        measures += 1;
        measure = null;
    };

    for (const element of elements(xml)) {
        const { name, close, index } = element;

        if (name === "part" && !close) {
            finishMeasure();
            part = /\bid="([^"]*)"/.exec(element.attrs)?.[1] ?? "";
        } else if (name === "divisions" && !close) divisions = Number(textAfter(xml, index));
        else if (name === "beats" && !close) beats = beatsOf(textAfter(xml, index));
        else if (name === "beat-type" && !close) beatType = Number(textAfter(xml, index));
        else if (name === "measure" && !close) {
            finishMeasure();
            measure = /number="([^"]+)"/.exec(element.attrs)?.[1] ?? "?";
            implicit = /implicit="yes"/.test(element.attrs);
            position = 0;
            voice = "1";
            perVoice = new Map();
        } else if (name === "measure" && close) {
            finishMeasure();
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

    return { measures, notes, divisions, uneven };
}
