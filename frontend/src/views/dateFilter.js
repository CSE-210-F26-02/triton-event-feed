import { append, createElementTree } from "../dom.js";
import { dayKey } from "../filters.js";

const emptySelection = () => ({
  mode: "multiple",
  dates: [],
  start: "",
  end: "",
});
const formatDay = (key) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${key}T12:00:00`));

/** Calendar with draft selections; Apply updates the shared list/map filter. */
export function createDateFilter(root, { onChange, now = new Date() }) {
  let month = new Date(now.getFullYear(), now.getMonth(), 1);
  let draft = emptySelection();
  let applied = null;
  let isOpen = false;
  const triggerButton = createElementTree(
    "button",
    {
      type: "button",
      class: "date-filter__trigger",
      "aria-label": "Choose event dates",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      "aria-controls": "event-date-picker",
      onclick: () => (isOpen ? close() : open()),
    },
    createElementTree("span", {
      class: "calendar-icon",
      "aria-hidden": "true",
    }),
  );
  const picker = createElementTree("div", {
    id: "event-date-picker",
    class: "date-picker",
    popover: "auto",
    role: "dialog",
    "aria-modal": "false",
    "aria-labelledby": "date-picker-title",
    hidden: true,
    onkeydown: (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        triggerButton.focus();
      }
    },
    ontoggle: (event) => {
      if (event.newState === "closed") {
        isOpen = false;
        triggerButton.setAttribute("aria-expanded", "false");
      }
    },
  });
  root.replaceChildren(triggerButton, picker);

  function close() {
    if (typeof picker.hidePopover === "function") picker.hidePopover();
    picker.hidden = true;
    isOpen = false;
    triggerButton.setAttribute("aria-expanded", "false");
  }

  function open() {
    draft = applied
      ? { ...applied, dates: [...(applied.dates || [])] }
      : emptySelection();
    const firstSelectedDay =
      draft.mode === "range" ? draft.start : draft.dates[0];
    if (firstSelectedDay) {
      const day = new Date(`${firstSelectedDay}T12:00:00`);
      month = new Date(day.getFullYear(), day.getMonth(), 1);
    }
    renderCalendarMonth();
    picker.hidden = false;
    const bounds = triggerButton.getBoundingClientRect();
    const popoverWidth = Math.min(352, window.innerWidth - 32);
    picker.style.left = `${Math.max(16, Math.min(bounds.right - popoverWidth, window.innerWidth - popoverWidth - 16))}px`;
    const popoverTop = Math.max(
      16,
      Math.min(
        bounds.bottom + 8,
        window.innerHeight - Math.min(520, window.innerHeight - 32) - 16,
      ),
    );
    picker.style.top = `${popoverTop}px`;
    picker.style.maxHeight = `${window.innerHeight - popoverTop - 16}px`;
    if (typeof picker.showPopover === "function") picker.showPopover();
    isOpen = true;
    triggerButton.setAttribute("aria-expanded", "true");
    picker.querySelector('[aria-pressed="true"]')?.focus();
  }

  function selectDay(key) {
    if (draft.mode === "multiple") {
      draft.dates = draft.dates.includes(key)
        ? draft.dates.filter((selectedDay) => selectedDay !== key)
        : [...draft.dates, key].sort();
    } else if (!draft.start || draft.end) {
      draft.start = key;
      draft.end = "";
    } else {
      [draft.start, draft.end] = [draft.start, key].sort();
    }
    renderCalendarMonth();
    picker.querySelector(`[data-date="${key}"]`)?.focus();
  }

  function renderCalendarMonth() {
    const selected = (key) =>
      draft.mode === "multiple"
        ? draft.dates.includes(key)
        : Boolean(
            draft.start &&
            key >= draft.start &&
            key <= (draft.end || draft.start),
          );
    const daysInMonth = new Date(
      month.getFullYear(),
      month.getMonth() + 1,
      0,
    ).getDate();
    const calendarCells = Array.from({ length: month.getDay() }, () =>
      createElementTree("span", { "aria-hidden": "true" }),
    );
    for (let dayOfMonth = 1; dayOfMonth <= daysInMonth; dayOfMonth++) {
      const date = new Date(month.getFullYear(), month.getMonth(), dayOfMonth);
      const key = dayKey(date);
      calendarCells.push(
        createElementTree(
          "button",
          {
            type: "button",
            class: `date-picker__day${key === dayKey(now) ? " date-picker__day--today" : ""}`,
            "aria-label": formatDay(key),
            "aria-pressed": String(selected(key)),
            "aria-current": key === dayKey(now) ? "date" : null,
            dataset: { date: key },
            onclick: () => selectDay(key),
          },
          String(dayOfMonth),
        ),
      );
    }
    const modeButton = (mode, label) =>
      createElementTree(
        "button",
        {
          type: "button",
          "aria-pressed": String(draft.mode === mode),
          onclick: () => {
            draft = { ...emptySelection(), mode };
            renderCalendarMonth();
            picker.querySelector(`[data-mode="${mode}"]`)?.focus();
          },
          dataset: { mode },
        },
        label,
      );
    const moveMonth = (offset) => {
      month = new Date(month.getFullYear(), month.getMonth() + offset, 1);
      renderCalendarMonth();
      picker
        .querySelector(
          offset < 0
            ? '[aria-label="Previous month"]'
            : '[aria-label="Next month"]',
        )
        ?.focus();
    };
    const valid =
      draft.mode === "multiple"
        ? draft.dates.length > 0
        : Boolean(draft.start && draft.end && draft.start <= draft.end);
    const selectionSummary =
      draft.mode === "multiple"
        ? `${draft.dates.length} date${draft.dates.length === 1 ? "" : "s"} selected`
        : !draft.start
          ? "Choose a start and end date."
          : !draft.end
            ? "Now choose the end date."
            : draft.start > draft.end
              ? "End date must be on or after start date."
              : `${formatDay(draft.start)} – ${formatDay(draft.end)}`;
    picker.replaceChildren();
    append(picker, [
      createElementTree(
        "div",
        { class: "date-picker__heading" },
        createElementTree("h3", { id: "date-picker-title" }, "Event dates"),
        createElementTree(
          "button",
          {
            type: "button",
            class: "date-picker__close",
            "aria-label": "Close calendar",
            onclick: () => {
              close();
              triggerButton.focus();
            },
          },
          "×",
        ),
      ),
      createElementTree(
        "div",
        { class: "date-picker__modes", "aria-label": "Date selection mode" },
        modeButton("multiple", "Multiple dates"),
        modeButton("range", "Date range"),
      ),
      createElementTree(
        "p",
        { class: "date-picker__hint" },
        draft.mode === "multiple"
          ? "Select one or more days. Click again to deselect."
          : "Select the first and last day of your range.",
      ),
      createElementTree(
        "div",
        { class: "date-picker__month" },
        createElementTree(
          "button",
          {
            type: "button",
            "aria-label": "Previous month",
            onclick: () => moveMonth(-1),
          },
          "‹",
        ),
        createElementTree(
          "span",
          { "aria-live": "polite" },
          new Intl.DateTimeFormat("en-US", {
            month: "long",
            year: "numeric",
          }).format(month),
        ),
        createElementTree(
          "button",
          {
            type: "button",
            "aria-label": "Next month",
            onclick: () => moveMonth(1),
          },
          "›",
        ),
      ),
      createElementTree(
        "div",
        { class: "date-picker__weekdays", "aria-hidden": "true" },
        ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((weekdayLabel) =>
          createElementTree("span", null, weekdayLabel),
        ),
      ),
      createElementTree(
        "div",
        { class: "date-picker__days", "aria-label": "Choose dates" },
        calendarCells,
      ),
      draft.mode === "range" &&
        createElementTree(
          "div",
          { class: "date-picker__range" },
          ...["start", "end"].map((field) =>
            createElementTree(
              "label",
              null,
              field === "start" ? "Start date" : "End date",
              createElementTree("input", {
                type: "date",
                value: draft[field],
                min: field === "end" ? draft.start : null,
                onchange: (event) => {
                  draft[field] = event.target.value;
                  renderCalendarMonth();
                  picker
                    .querySelectorAll("input")
                    [field === "start" ? 0 : 1]?.focus();
                },
              }),
            ),
          ),
        ),
      createElementTree(
        "p",
        { class: "date-picker__summary", role: "status" },
        selectionSummary,
      ),
      createElementTree(
        "div",
        { class: "date-picker__actions" },
        createElementTree(
          "button",
          {
            type: "button",
            class: "btn",
            onclick: () => {
              close();
              onChange(null);
              triggerButton.focus();
            },
          },
          "Clear",
        ),
        createElementTree(
          "button",
          {
            type: "button",
            class: "btn btn--gold",
            disabled: !valid,
            onclick: () => {
              const nextDraft = { ...draft, dates: [...draft.dates] };
              close();
              onChange(nextDraft);
              triggerButton.focus();
            },
          },
          "Apply",
        ),
      ),
    ]);
  }

  function render(selection) {
    applied = selection;
    const label = !selection
      ? "Choose event dates"
      : selection.mode === "range"
        ? `${formatDay(selection.start)} – ${formatDay(selection.end)}`
        : selection.dates.map(formatDay).join(", ");
    triggerButton.setAttribute(
      "aria-label",
      !selection ? label : `Filter event dates: ${label}`,
    );
    triggerButton.title = label;
    triggerButton.classList.toggle(
      "date-filter__trigger--active",
      Boolean(selection),
    );
  }
  document.addEventListener("pointerdown", (event) => {
    if (isOpen && !root.contains(event.target)) close();
  });
  render(null);
  return { render };
}
