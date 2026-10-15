// Checks the hand-written-score serializer: that lengths decompose into
// writable notes, that notes crossing a bar line are split and tied, and that
// every measure it writes adds up to the time signature.
//
//   npm run test:editor

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    DIVISIONS,
    decompose,
    emptyScore,
    spellMidi,
    ticksOf,
    toMusicXml,
    FLAT,
} from "../public/js/editor/model.js";

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}`);
    if (!ok) { console.log(`       expected ${JSON.stringify(expected)}`); failures += 1; }
}

function note(midi, duration, extra = {}) {
    return { midi, duration, dots: 0, ...extra };
}

console.log("\nlengths");
check("a quarter is a quarter", decompose(DIVISIONS), [{ duration: "quarter", dots: 0 }]);
check("three eighths are a dotted quarter", decompose(DIVISIONS * 1.5), [
    { duration: "quarter", dots: 1 },
]);
check("five eighths split into two notes", decompose(DIVISIONS * 2.5), [
    { duration: "half", dots: 0 },
    { duration: "eighth", dots: 0 },
]);
check("a dotted half is one note", decompose(DIVISIONS * 3), [{ duration: "half", dots: 1 }]);
check("a dotted quarter measures 720", ticksOf({ duration: "quarter", dots: 1 }), 720);

console.log("\nspelling");
check("middle C", spellMidi(60), { step: "C", alter: 0, octave: 4 });
check("C sharp", spellMidi(61), { step: "C", alter: 1, octave: 4 });
check("the same key as D flat", spellMidi(61, FLAT), { step: "D", alter: -1, octave: 4 });
check("B below", spellMidi(59), { step: "B", alter: 0, octave: 3 });

console.log("\nwriting a score");
const score = { ...emptyScore(), title: "Test", notes: [
    note(60, "quarter"), note(62, "quarter"), note(64, "half"),
    note(65, "whole"),
] };
const xml = toMusicXml(score);
check("it is a partwise score", xml.includes("<score-partwise"), true);
check("the title is in it", xml.includes("<work-title>Test</work-title>"), true);
check("the tempo is in it", xml.includes('<sound tempo="100"/>'), true);

console.log("\ncrossing a bar line");
// A whole note starting on beat 3 of 4/4 has to break across the bar.
const crossing = { ...emptyScore(), notes: [note(60, "half"), note(62, "whole")] };
const crossingXml = toMusicXml(crossing);
check("the note is tied", crossingXml.includes('<tie type="start"/>'), true);
check("and tied back", crossingXml.includes('<tie type="stop"/>'), true);
check("with notation to match", crossingXml.includes('<tied type="start"/>'), true);

console.log("\nrests and padding");
const padded = { ...emptyScore(), notes: [note(60, "quarter"), { rest: true, duration: "quarter" }] };
const paddedXml = toMusicXml(padded);
check("rests are written", paddedXml.includes("<rest/>"), true);
check("a rest is never tied", /<rest\/>[\s\S]{0,200}?<tie /.test(paddedXml), false);

// Every file above must satisfy the same rule the samples do.
console.log("\nevery measure adds up");
const dir = mkdtempSync(join(tmpdir(), "editor-"));
const files = { "basic.musicxml": xml, "crossing.musicxml": crossingXml, "padded.musicxml": paddedXml };

// A run of odd lengths, to push the splitter.
const messy = { ...emptyScore(), beats: 3, beatType: 4, notes: [
    note(60, "half", { dots: 1 }), note(62, "eighth"), note(64, "whole"),
    note(65, "quarter", { dots: 1 }), { rest: true, duration: "eighth" },
] };
files["messy.musicxml"] = toMusicXml(messy);

const paths = Object.entries(files).map(([name, content]) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
});

const result = spawnSync(process.execPath, ["tools/check-musicxml.mjs", ...paths], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
});
process.stdout.write(result.stdout.replace(/^/gm, "  "));
if (result.status !== 0) { process.stderr.write(result.stderr); failures += 1; }

// Any mix of lengths a person can pick - dotted, triplet, rest, chord - in any
// time signature, must come out with every measure adding up and no time lost.
// Greedy splitting once stranded remainders like 40 ticks that nothing writes.
console.log("\nrandom scores add up");
check("a 1320-tick remainder is a half and a dotted eighth, not a lost 40",
    decompose(1320), [{ duration: "half", dots: 0 }, { duration: "eighth", dots: 1 }]);
check("60 ticks is a 32nd, though the palette stops at sixteenths",
    decompose(60), [{ duration: "32nd", dots: 0 }]);
{
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const wrong = [];
    for (let trial = 0; trial < 2000; trial++) {
        const score = emptyScore(random() < 0.2 ? "drums" : "pitched");
        [score.beats, score.beatType] = pick([[4, 4], [3, 4], [2, 4], [6, 8]]);
        const count = 1 + Math.floor(random() * 14);
        for (let i = 0; i < count; i++) {
            const n = { duration: pick(["whole", "half", "quarter", "eighth", "16th"]), dots: random() < 0.2 ? 1 : 0 };
            if (random() < 0.25) n.tuplet = 3;
            if (random() < 0.15) n.rest = true;
            else if (score.kind === "drums") n.drums = [pick([36, 38, 42])];
            else n.midis = random() < 0.2 ? [60, 64] : [60 + Math.floor(random() * 12)];
            score.notes.push(n);
        }
        const xml = toMusicXml(score);
        const perMeasure = (DIVISIONS * 4 * score.beats) / score.beatType;
        const written = score.notes.reduce((sum, n) => sum + ticksOf(n), 0);
        let total = 0;
        for (const measure of xml.match(/<measure[\s\S]*?<\/measure>/g)) {
            const sum = (measure.match(/<note>[\s\S]*?<\/note>/g) ?? [])
                .filter((n) => !n.includes("<chord/>"))
                .reduce((s, n) => s + Number(/<duration>([^<]*)</.exec(n)[1]), 0);
            if (sum !== perMeasure) wrong.push(`trial ${trial}: a measure of ${sum}, not ${perMeasure}`);
            total += sum;
        }
        if (total < written) wrong.push(`trial ${trial}: ${written - total} ticks lost`);
    }
    check("2000 random scores, every measure adds up", wrong.slice(0, 3), []);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
