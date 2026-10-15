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

/** Long edge after scaling. Comfortably above what either provider keeps. */
export const MAX_EDGE = 2400;

/**
 * Returns a file ready to upload: upright, no larger than MAX_EDGE on its long
 * side, and in a format both providers accept. Anything that is not an image -
 * a PDF - comes back untouched, as does an image the browser cannot decode.
 */
export async function preparePhoto(file) {
    if (!file.type.startsWith("image/")) return file;

    let bitmap;
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
        // Some browsers cannot decode some formats (HEIC outside Safari).
        // Send the original and let the server have a go.
        return file;
    }

    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    // Paper is white: fill first so a transparent PNG does not turn black.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    // A screenshot or scan is crisp line art, which JPEG would smear; keep
    // those as PNG. A photo is what JPEG is for.
    const keepPng = file.type === "image/png";
    const type = keepPng ? "image/png" : "image/jpeg";
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
    if (!blob) return file;

    const name = file.name.replace(/\.[^.]+$/, "") + (keepPng ? ".png" : ".jpg");
    return new File([blob], name, { type });
}
