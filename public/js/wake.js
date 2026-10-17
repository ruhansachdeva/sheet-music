// Keeps a phone's screen on while something long is happening in the page.
//
// A reading takes minutes, and on the hosted site it runs in the page itself.
// If the screen locks part-way, the browser suspends the page and the
// connection to the reader drops - the reading, and one of the day's free
// requests, are lost. A screen wake lock stops that. Browsers without the
// Wake Lock API, or that refuse it (low battery), carry on as before.

/**
 * Holds the screen on until the returned function is called. The lock is let
 * go by the browser whenever the page is hidden, so it is taken again each
 * time the page comes back while still held.
 */
export function keepScreenOn() {
    if (!navigator.wakeLock) return () => {};

    let lock = null;
    let held = true;
    const take = async () => {
        if (!held || document.visibilityState !== "visible" || (lock && !lock.released)) return;
        try {
            lock = await navigator.wakeLock.request("screen");
            if (!held) lock.release(); // let go while it was being taken
        } catch {
            // Refused: the reading carries on, the screen may lock.
        }
    };
    document.addEventListener("visibilitychange", take);
    take();

    return () => {
        held = false;
        document.removeEventListener("visibilitychange", take);
        lock?.release().catch(() => {});
    };
}
