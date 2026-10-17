// Checks the pieces that make a reading whole, with fake model answers: no
// browser, no network, a second or so.
//
//   npm run test:reader

import { readFileSync } from "node:fs";
import { checkMeasures, missingMeasures } from "../public/js/reader/measures.js";
import * as read from "../public/js/reader/read.js";
import { stripCuts } from "../public/js/strips.js";

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}`);
    if (!ok) { console.log(`       expected ${JSON.stringify(expected)}`); failures += 1; }
}

const twinkle = readFileSync(new URL("../samples/twinkle.musicxml", import.meta.url), "utf8");
const bar = (n, xml = twinkle) => new RegExp(`<measure number="${n}"[\\s\\S]*?</measure>`).exec(xml)[0];
const numbers = (xml) => [...xml.matchAll(/<measure number="(\d+)"/g)].map((m) => m[1]);
const attributes = /<attributes>[\s\S]*?<\/attributes>/.exec(bar(1))[0];

/** A generate function that hands back the answers given, in turn, and keeps what it was asked. */
function model(...answers) {
    const asked = [];
    const generate = async (request) => {
        asked.push(request);
        const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
        if (answer instanceof Error) throw answer;
        return typeof answer === "string" ? { text: answer } : answer;
    };
    return { generate, asked };
}
const reading = (musicxml) => JSON.stringify({ title: "Twinkle", musicxml, instrument: "piano", questions: [] });

console.log("\nan answer cut off part-way");
check("a field is read as far as it got", read.partialField('{"title":"Twi', "title"), "Twi");
check("escapes included", read.partialField('{"musicxml":"<a x=\\"1\\"/>\\n<b', "musicxml"), '<a x="1"/>\n<b');
check("a cut mid-escape stops before it", read.partialField('{"t":"ab\\', "t"), "ab");
check("a finished field is whole", read.partialField('{"t":"done","u":1}', "t"), "done");
check("a field that never started is null", read.partialField('{"title":"x"', "musicxml"), null);

const upTo2 = twinkle.slice(0, twinkle.indexOf(bar(2)) + bar(2).length);
check("where a score stops", (({ number, part, partId, parts }) => ({ number, part, partId, parts }))(read.lastMeasure(upTo2)),
    { number: "2", part: 1, partId: "P1", parts: 1 });
const rest = twinkle.slice(twinkle.indexOf(bar(3)));
check("the rest joins on", numbers(read.join(upTo2, rest)), ["1", "2", "3", "4"]);
check("bars it repeats are dropped", numbers(read.join(upTo2, bar(2) + rest)), ["1", "2", "3", "4"]);
check("so is a document written out again", numbers(read.join(upTo2, twinkle)), ["1", "2", "3", "4"]);
check("a rest that does not line up is refused", read.join(upTo2, "<note>stray</note>"), null);

const cutAt = (text, at) => JSON.stringify({ title: "Twinkle", musicxml: text.slice(0, at) }).slice(0, -2);
const long = model(
    { text: cutAt(twinkle, twinkle.indexOf(bar(3)) + 20), incomplete: true },
    { text: JSON.stringify({ rest, instrument: "piano", questions: [] }) },
);
const carried = await read.transcribe(long.generate, { file: {}, instrument: "piano" });
check("a reading that ran out of room is carried on", [numbers(carried.musicxml), long.asked.length], [["1", "2", "3", "4"], 2]);
check("from the bar after the last finished one", /stops after measure 2/.test(long.asked[1].text), true);

console.log("\nchecking bars");
check("a sample adds up", checkMeasures(twinkle).uneven, []);
const short = twinkle.replace(bar(2), bar(2).replace("<duration>480</duration>", "<duration>240</duration>"));
check("a bar a sixteenth short is uneven", checkMeasures(short).uneven.map((u) => [u.measure, u.voice, u.total, u.expected])[0],
    ["2", "1", 1680, 1920]);
check("a pickup marked implicit is not", checkMeasures(short.replace('<measure number="2"', '<measure number="2" implicit="yes"')).uneven, []);
check("3+2 is five beats", checkMeasures(twinkle.replace("<beats>4</beats>", "<beats>3+1</beats>")).uneven, []);
check("bars skipped are found by number", missingMeasures(twinkle.replace(bar(2), "").replace(bar(3), "")), [{ part: "P1", numbers: [2, 3] }]);
check("a pickup bar 0 is not a gap", missingMeasures(twinkle.replace('<measure number="1"', '<measure number="0"').replace(bar(2), bar(2).replace('number="2"', 'number="1"'))).length, 1);

console.log("\nputting a reading right");
const fixed = model(reading(short), JSON.stringify({ measures: [{ part: "P1", number: "2", musicxml: bar(2) }] }));
const evened = await read.transcribe(fixed.generate, { file: {}, instrument: "piano" });
check("a bar that does not add up is swapped for the recheck's", [evened.musicxml === twinkle, evened.uneven], [true, []]);
const stillWrong = model(reading(short), JSON.stringify({ measures: [{ part: "P1", number: "2", musicxml: bar(2, short) }] }));
check("one still wrong is kept, and named", (await read.transcribe(stillWrong.generate, { file: {}, instrument: "piano" })).uneven, ["2"]);
const failing = model(reading(short), new Error("busy"));
check("a recheck that fails keeps the reading", (await read.transcribe(failing.generate, { file: {}, instrument: "piano" })).uneven, ["2"]);
const lostAttributes = model(reading(twinkle.replace(bar(1), bar(1).replace("<duration>480</duration>", "<duration>240</duration>"))),
    JSON.stringify({ measures: [{ part: "P1", number: "1", musicxml: bar(1).replace(attributes, "") }] }));
check("a fix that loses the time signature is refused",
    (await read.transcribe(lostAttributes.generate, { file: {}, instrument: "piano" })).uneven, ["1"]);

const skipped = twinkle.replace(bar(1), "").replace(bar(2), "").replace(/(<measure number="3"[^>]*>)/, `$1${attributes}`);
const filling = model(reading(skipped), JSON.stringify({
    measures: [{ part: "P1", number: "2", musicxml: bar(2) }, { part: "P1", number: "1", musicxml: bar(1).replace(attributes, "") }],
}));
const filled = await read.transcribe(filling.generate, { file: {}, instrument: "piano" });
check("skipped bars are asked for", /measures 1-2/.test(filling.asked[1].text), true);
check("and put back in order", numbers(filled.musicxml), ["1", "2", "3", "4"]);
check("the new first bar gets the time signature", [bar(1, filled.musicxml).includes("<divisions>"), filled.uneven, filled.missing], [true, [], []]);
const unfilled = model(reading(skipped), JSON.stringify({ measures: [] }));
check("bars still missing are named", (await read.transcribe(unfilled.generate, { file: {}, instrument: "piano" })).missing, [1, 2]);

console.log("\ncutting a page into strips");
// Ten systems of 120 rows with 85 rows of paper between, under a title.
const page = new Array(2400).fill(0);
for (let y = 40; y < 80; y++) page[y] = 30;
for (let s = 0; s < 10; s++) for (let y = 150 + s * 205; y < 270 + s * 205; y++) page[y] = 300;
const cuts = stripCuts(page, { minGap: 14, target: 600 });
check("between systems, about two to a strip", cuts, [518, 928, 1338, 1748]);
check("each cut in blank paper", cuts.every((y) => page[y] === 0), true);
check("a page of two systems is read whole", stripCuts(page.map((v, y) => (y < 400 ? v : 0)), { minGap: 14, target: 600 }), []);
check("so is one with no gaps", stripCuts(page.map(() => 5), { minGap: 14, target: 600 }), []);
check("too many strips grow until they fit", stripCuts(page, { minGap: 14, target: 50, most: 4 }).length + 1 <= 4, true);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
