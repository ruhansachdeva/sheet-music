// The clarifying-question panel: Claude's questions about a photo or PDF, with
// one button per suggested answer, a free-text box, and a skip. Answers go back
// to /api/refine; skipped questions keep Claude's best guess.

export class QuestionPanel {
    constructor(container, { onSubmit }) {
        this.container = container;
        this.onSubmit = onSubmit;
        this.questions = [];
        this.answers = new Map();
    }

    show(questions) {
        this.questions = questions ?? [];
        this.answers = new Map();

        if (this.questions.length === 0) {
            this.hide();
            return;
        }
        this.render();
        this.container.hidden = false;
    }

    hide() {
        this.container.hidden = true;
        this.container.innerHTML = "";
    }

    render() {
        this.container.innerHTML = "";

        const heading = document.createElement("div");
        heading.className = "questions-head";
        heading.innerHTML = `
            <h2>Claude wasn't sure about ${this.questions.length}
                ${this.questions.length === 1 ? "thing" : "things"}</h2>
            <p>Answer what you know and skip the rest - it will use its best guess for those.
               The score below already plays.</p>`;
        this.container.appendChild(heading);

        for (const question of this.questions) {
            this.container.appendChild(this.renderQuestion(question));
        }

        const actions = document.createElement("div");
        actions.className = "questions-actions";

        const apply = document.createElement("button");
        apply.className = "primary";
        apply.textContent = "Send answers to Claude";
        apply.disabled = true;
        apply.addEventListener("click", () => this.submit());

        const skipAll = document.createElement("button");
        skipAll.textContent = "Skip all";
        skipAll.addEventListener("click", () => this.hide());

        actions.append(apply, skipAll);
        this.container.appendChild(actions);
        this.applyButton = apply;
    }

    renderQuestion(question) {
        const card = document.createElement("div");
        card.className = "question";

        const label = document.createElement("p");
        label.className = "question-text";
        label.innerHTML = `<span class="measure">m. ${question.measure}</span> ${escapeHtml(
            question.question,
        )}`;
        card.appendChild(label);

        const choices = document.createElement("div");
        choices.className = "choices";

        for (const option of question.options ?? []) {
            const button = document.createElement("button");
            button.className = "choice";
            button.textContent = option;
            button.addEventListener("click", () => {
                this.answers.set(question.id, { question: question.question, answer: option });
                markChosen(choices, button);
                freeText.value = "";
                this.refreshApply();
            });
            choices.appendChild(button);
        }

        const skip = document.createElement("button");
        skip.className = "choice skip";
        skip.textContent = "Skip";
        skip.addEventListener("click", () => {
            this.answers.delete(question.id);
            markChosen(choices, skip);
            freeText.value = "";
            this.refreshApply();
        });
        choices.appendChild(skip);
        card.appendChild(choices);

        const freeText = document.createElement("input");
        freeText.type = "text";
        freeText.className = "free-text";
        freeText.placeholder = "Or type your own answer";
        freeText.addEventListener("input", () => {
            const value = freeText.value.trim();
            if (value) {
                this.answers.set(question.id, { question: question.question, answer: value });
                markChosen(choices, null);
            } else {
                this.answers.delete(question.id);
            }
            this.refreshApply();
        });
        card.appendChild(freeText);

        return card;
    }

    refreshApply() {
        if (this.applyButton) this.applyButton.disabled = this.answers.size === 0;
    }

    submit() {
        const answers = [...this.answers.values()];
        if (answers.length === 0) return;
        this.onSubmit(answers);
    }

    setBusy(busy) {
        if (!this.applyButton) return;
        this.applyButton.disabled = busy || this.answers.size === 0;
        this.applyButton.textContent = busy ? "Claude is correcting…" : "Send answers to Claude";
    }
}

function markChosen(group, chosen) {
    for (const button of group.querySelectorAll(".choice")) {
        button.classList.toggle("chosen", button === chosen);
    }
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}
