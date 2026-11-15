import type { TopicOption } from "../types";

// Text-only DOM keeps labels and notes safe even inside agent-authored replies.
export function optionsList(
  doc: Document,
  options: readonly TopicOption[],
  selected: number,
  requested: boolean,
  pick: (index: number) => void,
): HTMLElement {
  const section = doc.createElement("section");
  section.className = "topic-options";
  const title = doc.createElement("div");
  title.className = "topic-options-label";
  title.textContent = "Options";
  const list = doc.createElement("div");
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-label", "Options");
  section.append(title, list);
  options.forEach((option, index) => {
    const row = doc.createElement("div");
    row.dataset.optionPart = `option:${index + 1}`;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "topic-option";
    button.setAttribute("role", "radio");
    button.tabIndex = index === (selected < 0 ? 0 : selected) ? 0 : -1;
    button.setAttribute("aria-checked", String(index === selected));
    const label = doc.createElement("span");
    label.className = "topic-option-label";
    label.textContent = option.label;
    button.append(label);
    for (const tag of [
      option.ships && "What ships",
      option.recommended && "Agent recommends",
      requested && index === selected && "Change requested",
    ].filter(Boolean)) {
      const badge = doc.createElement("span");
      badge.className =
        "topic-option-tag" +
        (tag === "Agent recommends"
          ? " recommended"
          : tag === "Change requested"
            ? " requested"
            : "");
      badge.textContent = String(tag);
      button.append(badge);
    }
    if (option.note) {
      const note = doc.createElement("span");
      note.className = "topic-option-note";
      note.textContent = option.note;
      button.append(note);
    }
    button.onclick = (event) => {
      if (!event.shiftKey) pick(index);
    };
    button.onkeydown = (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        pick(index);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const next =
        (index + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : options.length - 1)) %
        options.length;
      const target = list.querySelectorAll<HTMLButtonElement>(".topic-option")[next];
      button.tabIndex = -1;
      if (target) {
        target.tabIndex = 0;
        target.focus();
      }
    };
    row.append(button);
    list.append(row);
  });
  return section;
}
