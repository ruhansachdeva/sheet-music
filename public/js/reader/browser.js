// Reading a photo in the page itself, with your own Gemini key, for when no
// server is behind the page - the hosted copy. The key is kept in this
// browser's storage and sent nowhere but Google; the reading is the same
// shared code the server runs.

import { API_BASE, generate } from "./gemini.js";
import * as read from "./read.js";

const KEY = "gemini-key";
// Where requests go, if not to Google: a proxy, or a stand-in in the tests.
const BASE = "gemini-api-base";

function stored(name) {
    try {
        return localStorage.getItem(name);
    } catch {
        return null; // storage blocked: as if nothing were saved
    }
}

/** The key saved in this browser, or null. */
export function savedKey() {
    return stored(KEY);
}

/** Saves the key, or returns false if this browser will not store it. */
export function saveKey(key) {
    try {
        localStorage.setItem(KEY, key);
        return true;
    } catch {
        return false;
    }
}

export function forgetKey() {
    try {
        localStorage.removeItem(KEY);
    } catch {
        // Nothing stored, then.
    }
}

function settings(apiKey = savedKey(), onProgress) {
    return { apiKey, apiBase: stored(BASE) || API_BASE, onProgress };
}

/**
 * Whether Google accepts a key, by listing models with it - which costs
 * nothing against the free tier's readings. Returns null if it does, or what
 * is wrong.
 */
export async function checkKey(apiKey) {
    const { apiBase } = settings(apiKey);
    let response;
    try {
        response = await fetch(`${apiBase}/models?pageSize=1`, { headers: { "x-goog-api-key": apiKey } });
    } catch {
        return "Could not reach Google to check the key. Check the connection and try again.";
    }
    if (response.ok) return null;
    if ([400, 401, 403].includes(response.status)) {
        return "Google did not accept that key. Copy it again from Google AI Studio.";
    }
    return `Google could not check the key just now (${response.status}). Try again in a moment.`;
}

/**
 * The same request a server provider gets, with the file as base64.
 * `onProgress` hears each heading of the model's thinking as it streams in.
 */
function generateHere(onProgress) {
    return async (request) => {
        const file = { data: await base64(request.file), mimeType: mimeTypeOf(request.file) };
        return generate({ ...request, file }, settings(savedKey(), onProgress));
    };
}

export function transcribe({ file, instrument, onProgress }) {
    const progress = withPlace(onProgress);
    return read.transcribe(generateHere(progress), {
        file, instrument, onContinue: progress.after, onRecheck: progress.recheck,
    });
}

export function refine({ file, instrument, musicxml, answers, onProgress }) {
    const progress = withPlace(onProgress);
    return read.refine(generateHere(progress), {
        file, instrument, musicxml, answers, onContinue: progress.after, onRecheck: progress.recheck,
    });
}

/**
 * The model's headings - with, once a reading has gone past one answer, what
 * the later answer is for in front of them: the bar a dense page is carrying
 * on after, or the bars being looked at again. A reading that is still going
 * should not look like one that has started over.
 */
function withPlace(onProgress = () => {}) {
    let place = "";
    const progress = (heading) => onProgress(place ? `${place} · ${heading}` : heading);
    const now = (what) => {
        place = what;
        onProgress(place);
    };
    progress.after = (bar) => now(`carrying on after bar ${bar}`);
    progress.recheck = (bars) => now(`rechecking ${bars} bar${bars === 1 ? "" : "s"} that did not add up`);
    return progress;
}

function base64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/** A file's type - which some phones leave blank - from its name if need be. */
function mimeTypeOf(file) {
    if (file.type) return file.type;
    const extension = /\.(\w+)$/.exec(file.name ?? "")?.[1]?.toLowerCase();
    return { pdf: "application/pdf", heic: "image/heic", heif: "image/heif", png: "image/png" }[extension]
        ?? "image/jpeg";
}
