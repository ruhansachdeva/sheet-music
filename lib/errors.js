/** An error with a status code, safe to show the user. */
export class TranscribeError extends Error {
    constructor(message, status = 500) {
        super(message);
        this.status = status;
    }
}
