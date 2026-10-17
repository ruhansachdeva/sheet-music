// Gets a photo ready to be read before it leaves the phone.
//
// A phone camera produces something like 4032 x 3024 at several megabytes.
// Neither provider reads at that size - both scale large images down first -
// so sending it all only makes the upload slow on mobile data. Phones also
// often store the picture sideways with an EXIF flag saying how to turn it,
// and a model honouring that flag is not something to rely on.
//
// Decoding the image and drawing it onto a canvas fixes both: the browser
// applies the orientation while decoding, and the canvas is drawn at the size
// actually needed.
//
// A page exported from notation software may be an SVG instead. The model
// cannot see a picture in SVG source - it gets hundreds of kilobytes of path
// data - so that is drawn onto the canvas too, as the picture it describes.

import { inkPerRow, stripCuts } from "./strips.js";

/** Long edge after scaling. Comfortably above what either provider keeps. */
export const MAX_EDGE = 2400;

/** CSS pixels per unit, for an SVG's width and height. */
const UNITS = { "": 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };

export function isSvg(file) {
    return file.type === "image/svg+xml" || /\.svg$/i.test(file.name ?? "");
}

/**
 * Returns a file ready to upload: upright, no larger than MAX_EDGE on its long
 * side, and in a format both providers accept. Anything that is not an image -
 * a PDF - comes back untouched, as does an image the browser cannot decode.
 * An SVG that cannot be drawn is an error: sent as it is, it cannot be read.
 */
export async function preparePhoto(file) {
    const svg = isSvg(file);
    if (!svg && !file.type.startsWith("image/")) return file;

    const picture = svg ? await svgPicture(file) : await bitmap(file);
    if (!picture) {
        if (svg) throw new Error(`Could not draw ${file.name}. Save the page as a PNG or PDF and try that.`);
        return file;
    }

    // A drawing has no pixels of its own, so it is drawn at the full size.
    const scale = svg ? MAX_EDGE / Math.max(picture.width, picture.height)
        : Math.min(1, MAX_EDGE / Math.max(picture.width, picture.height));
    const width = Math.round(picture.width * scale);
    const height = Math.round(picture.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    // Paper is white: fill first so a transparent PNG does not turn black.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(picture, 0, 0, width, height);
    picture.close?.();

    // A screenshot, scan or drawing is crisp line art, which JPEG would smear;
    // keep those as PNG. A photo is what JPEG is for.
    const keepPng = svg || file.type === "image/png";
    const type = keepPng ? "image/png" : "image/jpeg";
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
    if (!blob) return file;

    const name = file.name.replace(/\.[^.]+$/, "") + (keepPng ? ".png" : ".jpg");
    return new File([blob], name, { type });
}

async function bitmap(file) {
    try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
        // Some browsers cannot decode some formats (HEIC outside Safari).
        // Send the original and let the server have a go.
        return null;
    }
}

/**
 * An SVG as an <img>, which every browser can draw - createImageBitmap cannot
 * decode SVG in Chrome. It is given its pixel size up front, so it is rendered
 * crisp at that size rather than drawn small and scaled up. Null if the file
 * is not an SVG the browser can draw.
 */
async function svgPicture(file) {
    let root;
    try {
        root = new DOMParser().parseFromString(await file.text(), "image/svg+xml").documentElement;
    } catch {
        return null;
    }
    if (root.localName !== "svg" || root.getElementsByTagName("parsererror").length) return null;

    // Its size: width and height where they are given in absolute units, else
    // the viewBox. Without a viewBox the drawing would not scale, so it gets one.
    const box = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
    const width = length(root.getAttribute("width")) || box?.[2];
    const height = length(root.getAttribute("height")) || box?.[3];
    if (!(width > 0 && height > 0)) return null;
    if (!box) root.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const scale = MAX_EDGE / Math.max(width, height);
    root.setAttribute("width", String(Math.round(width * scale)));
    root.setAttribute("height", String(Math.round(height * scale)));

    const source = new Blob([new XMLSerializer().serializeToString(root)], { type: "image/svg+xml" });
    const url = URL.createObjectURL(source);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        return image;
    } catch {
        return null;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** An SVG length in CSS pixels, or 0 for a relative one such as "100%". */
function length(value) {
    const match = /^\s*([\d.]+)\s*(px|pt|pc|in|cm|mm)?\s*$/.exec(value ?? "");
    return match ? Number(match[1]) * UNITS[match[2] ?? ""] : 0;
}

/**
 * A prepared page cut into strips between its systems, top to bottom, each at
 * the page's full width - or none, when the page does not split (a single
 * system, a skewed photo with no clear gaps, or something that is not an
 * image). See strips.js for why.
 */
export async function cutIntoStrips(page) {
    if (!page.type.startsWith("image/")) return [];
    let bitmap;
    try {
        bitmap = await createImageBitmap(page);
    } catch {
        return [];
    }
    const { width, height } = bitmap;

    // The gaps are found on a narrow copy - plenty to see blank paper - and
    // the strips cut from the full one.
    const narrow = Math.min(width, 600);
    const rows = Math.round((height * narrow) / width);
    const probe = document.createElement("canvas");
    probe.width = narrow;
    probe.height = rows;
    const g = probe.getContext("2d", { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0, narrow, rows);
    const ink = inkPerRow(g.getImageData(0, 0, narrow, rows).data, narrow, rows);
    const cuts = stripCuts(ink, {
        // Specks of dust or noise in a photo are not music.
        blank: Math.ceil(narrow * 0.004),
        // A blank band this tall is between systems, not inside one.
        minGap: Math.max(3, Math.round(rows * 0.006)),
        // About two systems of a typical page: wide strips, little height.
        target: Math.round(narrow * 0.3),
    }).map((y) => Math.round((y * height) / rows));

    const strips = [];
    const edges = [0, ...cuts, height];
    for (let i = 0; i + 1 < edges.length; i++) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = edges[i + 1] - edges[i];
        canvas.getContext("2d").drawImage(bitmap, 0, -edges[i]);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, page.type, 0.92));
        if (!blob) return [];
        strips.push(new File([blob], page.name.replace(/(\.[^.]+)?$/, `-${i + 1}$1`), { type: page.type }));
    }
    bitmap.close?.();
    return cuts.length ? strips : [];
}

/** pdf.js, loaded from the CDN the first time a PDF is opened. */
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";

/**
 * Above this many pages a PDF is sent as it is: drawn and cut up, it would
 * be too many images for one request.
 */
export const MAX_PDF_PAGES = 8;

/**
 * The pages of a PDF, drawn as PNGs at reading size on white paper - or none
 * if it is longer than MAX_PDF_PAGES, or will not open or draw.
 */
export async function pdfPages(file) {
    try {
        const pdfjs = await import(`${PDFJS}pdf.min.mjs`);
        pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
        const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        if (pdf.numPages > MAX_PDF_PAGES) return [];

        const name = file.name.replace(/\.[^.]+$/, "");
        const pages = [];
        for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n);
            const natural = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: MAX_EDGE / Math.max(natural.width, natural.height) });
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(viewport.width);
            canvas.height = Math.round(viewport.height);
            const context = canvas.getContext("2d");
            context.fillStyle = "#fff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: context, viewport }).promise;
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
            if (!blob) return [];
            pages.push(new File([blob], `${name}-page-${n}.png`, { type: "image/png" }));
        }
        await pdf.destroy();
        return pages;
    } catch {
        return [];
    }
}

/**
 * What a prepared file is best read from, in reading order: an image's
 * strips; or a PDF's pages, each cut into strips where it will cut. Empty when
 * the file is best read as it is.
 */
export async function stripsOf(file) {
    if (file.type !== "application/pdf") return cutIntoStrips(file);
    const strips = [];
    for (const page of await pdfPages(file)) {
        const cut = await cutIntoStrips(page);
        strips.push(...(cut.length ? cut : [page]));
    }
    return strips;
}
