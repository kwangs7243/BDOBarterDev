let nextListId = 0;

/** Create an editable canonical-value field with a visible, filterable options arrow. */
export function createAutocomplete({ className = "", options = [], value = "", ariaLabel, placeholder = "", onInput = () => {} }) {
  const root = document.createElement("span");
  root.className = `autocomplete-control ${className}`.trim();
  const input = document.createElement("input");
  input.type = "text";
  input.className = "autocomplete-input";
  input.value = value;
  input.autocomplete = "off";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", ariaLabel);
  input.setAttribute("aria-autocomplete", "list");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "autocomplete-toggle";
  toggle.textContent = "▾";
  toggle.title = "목록 열기";
  toggle.setAttribute("aria-label", `${ariaLabel} 목록 열기`);
  toggle.setAttribute("aria-expanded", "false");

  const list = document.createElement("span");
  list.className = "autocomplete-options";
  list.id = `autocomplete-options-${++nextListId}`;
  list.hidden = true;
  toggle.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-controls", list.id);

  let values = [];
  let expanded = false;
  const close = () => {
    expanded = false;
    list.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  const renderOptions = (filterCurrentValue = true) => {
    const query = filterCurrentValue ? input.value.trim().replace(/\s+/g, "").toLocaleLowerCase() : "";
    const matches = values.filter((item) => !query || item.replace(/\s+/g, "").toLocaleLowerCase().includes(query));
    list.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement("span");
      empty.className = "autocomplete-empty";
      empty.textContent = "일치하는 정식 항목이 없습니다. 직접 입력한 값으로 다시 확인합니다.";
      list.append(empty);
      return;
    }
    for (const item of matches) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "autocomplete-option";
      option.setAttribute("role", "option");
      option.textContent = item;
      option.addEventListener("click", () => {
        input.value = item;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        close();
        input.focus();
      });
      list.append(option);
    }
  };
  const open = (showAll = false) => {
    expanded = true;
    renderOptions(!showAll);
    list.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
  };

  toggle.addEventListener("click", () => expanded ? close() : open(true));
  input.addEventListener("input", () => {
    onInput(input.value);
    if (expanded || input.value) open();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && expanded) { event.stopPropagation(); close(); }
    if (event.key === "ArrowDown" && !expanded) { event.preventDefault(); open(true); }
  });
  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) close();
  });

  values = [...new Set(options.filter((item) => typeof item === "string" && item))];
  root.append(input, toggle, list);
  return {
    element: root,
    input,
    setOptions(nextOptions) {
      values = [...new Set(nextOptions.filter((item) => typeof item === "string" && item))];
      if (expanded) renderOptions();
    },
  };
}
