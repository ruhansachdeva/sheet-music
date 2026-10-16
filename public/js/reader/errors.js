/**
 * An error with an HTTP-style status, safe to show the user. Shared by the
 * server and the page, which read photos with the same code.
 */
export class ReadError extends Error {
    constructor(message, status = 500) {
        super(message);
        this.status = status;
    }
}
