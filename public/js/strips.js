// Where to cut a page of music into strips, so each line of music reaches the
// reader at a size it can see.
//
// A model looks at an image through a fixed number of tokens, however big the
// image is. A whole page of sixteenth-note drums squeezed into that many is
// too small to read a notehead's line or a dot: read whole, a dense page came
// back with about a third of its hits right. Cut into strips of a system or
// two, each strip gets the full detail.
//
// Systems are separated by blank paper - inside a system, the staff lines are
// ink on every row - so the cuts go in the middle of the blank bands.

/**
 * The rows to cut a page at, given how much ink each row of pixels has.
 * Blank bands at least `minGap` rows tall separate blocks of music; blocks are
 * grouped, top to bottom, into strips no taller than `target` rows where they
 * can be (a single block taller than that stays whole). Returns the cut rows,
 * strictly between 0 and the page's height - empty when the page does not
 * split into at least `fewest` strips, and it is better read whole.
 */
export function stripCuts(ink, { minGap, target, blank = 0, fewest = 2, most = 8 }) {
    // The blank bands, as [start, end) row ranges.
    const bands = [];
    let start = -1;
    for (let y = 0; y <= ink.length; y++) {
        const empty = y < ink.length && ink[y] <= blank;
        if (empty && start < 0) start = y;
        if (!empty && start >= 0) {
            if (y - start >= minGap) bands.push([start, y]);
            start = -1;
        }
    }

    // Candidate cuts: the middle of each band that has music on both sides.
    const firstInk = ink.findIndex((v) => v > blank);
    if (firstInk < 0) return [];
    const lastInk = ink.length - 1 - [...ink].reverse().findIndex((v) => v > blank);
    const candidates = bands
        .filter(([from, to]) => from > firstInk && to <= lastInk)
        .map(([from, to]) => Math.round((from + to) / 2));

    // Greedy: keep adding blocks to a strip until the next would make it too
    // tall - measured on the music, not the margins. More strips than `most`
    // means the target was too small for this page, so it grows until they fit.
    for (let tall = target; tall <= ink.length; tall *= 1.25) {
        const cuts = [];
        let top = firstInk;
        for (let i = 0; i < candidates.length; i++) {
            const next = candidates[i + 1] ?? lastInk + 1;
            if (next - top > tall) {
                cuts.push(candidates[i]);
                top = candidates[i];
            }
        }
        if (cuts.length + 1 > most) continue;
        return cuts.length + 1 >= fewest ? cuts : [];
    }
    return [];
}

/**
 * How much ink each row of an image has: the count of pixels clearly darker
 * than the paper. The paper's own brightness is taken from the image, so a
 * photo under warm light or in shadow still has a white to compare against.
 */
export function inkPerRow(pixels, width, height) {
    const luma = new Uint8Array(width * height);
    for (let i = 0; i < luma.length; i++) {
        luma[i] = (pixels[i * 4] * 299 + pixels[i * 4 + 1] * 587 + pixels[i * 4 + 2] * 114) / 1000;
    }
    // Paper is most of a page: the 75th-percentile brightness is the paper.
    const sorted = [...luma.filter((_, i) => i % 7 === 0)].sort((a, b) => a - b);
    const paper = sorted[Math.floor(sorted.length * 0.75)] ?? 255;
    const dark = paper - Math.max(48, paper * 0.3);

    const rows = new Array(height).fill(0);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) if (luma[y * width + x] < dark) rows[y]++;
    }
    return rows;
}
