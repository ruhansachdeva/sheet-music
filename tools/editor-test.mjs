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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
