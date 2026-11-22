import { append, h } from '../dom.js';
import { dayKey } from '../filters.js';

const emptySelection = () => ({ mode: 'multiple', dates: [], start: '', end: '' });
const formatDay = (key) => new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric',
}).format(new Date(`${key}T12:00:00`));

/** Calendar with draft selections; Apply updates the shared list/map filter. */
export function createDateFilter(root, { onChange, now = new Date() }) {
  let month = new Date(now.getFullYear(), now.getMonth(), 1);
  let draft = emptySelection();
  let applied = null;
  let isOpen = false;
  const trigger = h('button', {
    type: 'button', class: 'date-filter__trigger', 'aria-label': 'Choose event dates',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'event-date-picker',
    onclick: () => isOpen ? close() : open(),
  }, h('span', { class: 'calendar-icon', 'aria-hidden': 'true' }));
  const picker = h('div', {
    id: 'event-date-picker', class: 'date-picker', popover: 'auto', role: 'dialog',
    'aria-modal': 'false', 'aria-labelledby': 'date-picker-title', hidden: true,
    onkeydown: (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); }
    },
    ontoggle: (event) => {
      if (event.newState === 'closed') {
        isOpen = false;
        trigger.setAttribute('aria-expanded', 'false');
      }
    },
  });
  root.replaceChildren(trigger, picker);

  function close() {
    if (typeof picker.hidePopover === 'function') picker.hidePopover();
    picker.hidden = true;
    isOpen = false;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function open() {
    draft = applied ? { ...applied, dates: [...(applied.dates || [])] } : emptySelection();
    const first = draft.mode === 'range' ? draft.start : draft.dates[0];
    if (first) { const day = new Date(`${first}T12:00:00`); month = new Date(day.getFullYear(), day.getMonth(), 1); }
    draw();
    picker.hidden = false;
    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(352, window.innerWidth - 32);
    picker.style.left = `${Math.max(16, Math.min(bounds.right - width, window.innerWidth - width - 16))}px`;
    const top = Math.max(16, Math.min(bounds.bottom + 8, window.innerHeight - Math.min(520, window.innerHeight - 32) - 16));
    picker.style.top = `${top}px`;
    picker.style.maxHeight = `${window.innerHeight - top - 16}px`;
    if (typeof picker.showPopover === 'function') picker.showPopover();
    isOpen = true;
    trigger.setAttribute('aria-expanded', 'true');
    picker.querySelector('[aria-pressed="true"]')?.focus();
  }

  function selectDay(key) {
    if (draft.mode === 'multiple') {
      draft.dates = draft.dates.includes(key) ? draft.dates.filter((d) => d !== key) : [...draft.dates, key].sort();
    } else if (!draft.start || draft.end) {
      draft.start = key; draft.end = '';
    } else {
      [draft.start, draft.end] = [draft.start, key].sort();
    }
    draw();
    picker.querySelector(`[data-date="${key}"]`)?.focus();
  }

  function draw() {
    const selected = (key) => draft.mode === 'multiple' ? draft.dates.includes(key)
      : Boolean(draft.start && key >= draft.start && key <= (draft.end || draft.start));
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells = Array.from({ length: month.getDay() }, () => h('span', { 'aria-hidden': 'true' }));
    for (let day = 1; day <= days; day++) {
      const date = new Date(month.getFullYear(), month.getMonth(), day);
      const key = dayKey(date);
      cells.push(h('button', {
        type: 'button', class: `date-picker__day${key === dayKey(now) ? ' date-picker__day--today' : ''}`,
        'aria-label': formatDay(key), 'aria-pressed': String(selected(key)),
        'aria-current': key === dayKey(now) ? 'date' : null, dataset: { date: key }, onclick: () => selectDay(key),
      }, String(day)));
    }
    const modeButton = (mode, label) => h('button', {
      type: 'button', 'aria-pressed': String(draft.mode === mode),
      onclick: () => { draft = { ...emptySelection(), mode }; draw(); picker.querySelector(`[data-mode="${mode}"]`)?.focus(); },
      dataset: { mode },
    }, label);
    const moveMonth = (offset) => {
      month = new Date(month.getFullYear(), month.getMonth() + offset, 1);
      draw(); picker.querySelector(offset < 0 ? '[aria-label="Previous month"]' : '[aria-label="Next month"]')?.focus();
    };
    const valid = draft.mode === 'multiple' ? draft.dates.length > 0
      : Boolean(draft.start && draft.end && draft.start <= draft.end);
    const summary = draft.mode === 'multiple'
      ? `${draft.dates.length} date${draft.dates.length === 1 ? '' : 's'} selected`
      : !draft.start ? 'Choose a start and end date.'
        : !draft.end ? 'Now choose the end date.'
          : draft.start > draft.end ? 'End date must be on or after start date.'
            : `${formatDay(draft.start)} – ${formatDay(draft.end)}`;
    picker.replaceChildren();
    append(picker, [
      h('div', { class: 'date-picker__heading' },
        h('h3', { id: 'date-picker-title' }, 'Event dates'),
        h('button', { type: 'button', class: 'date-picker__close', 'aria-label': 'Close calendar', onclick: () => { close(); trigger.focus(); } }, '×')),
      h('div', { class: 'date-picker__modes', 'aria-label': 'Date selection mode' },
        modeButton('multiple', 'Multiple dates'), modeButton('range', 'Date range')),
      h('p', { class: 'date-picker__hint' }, draft.mode === 'multiple'
        ? 'Select one or more days. Click again to deselect.' : 'Select the first and last day of your range.'),
      h('div', { class: 'date-picker__month' },
        h('button', { type: 'button', 'aria-label': 'Previous month', onclick: () => moveMonth(-1) }, '‹'),
        h('span', { 'aria-live': 'polite' }, new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(month)),
        h('button', { type: 'button', 'aria-label': 'Next month', onclick: () => moveMonth(1) }, '›')),
      h('div', { class: 'date-picker__weekdays', 'aria-hidden': 'true' }, ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => h('span', null, d))),
      h('div', { class: 'date-picker__days', 'aria-label': 'Choose dates' }, cells),
      draft.mode === 'range' && h('div', { class: 'date-picker__range' },
        ...['start', 'end'].map((field) => h('label', null, field === 'start' ? 'Start date' : 'End date',
          h('input', { type: 'date', value: draft[field], min: field === 'end' ? draft.start : null,
            onchange: (event) => { draft[field] = event.target.value; draw(); picker.querySelectorAll('input')[field === 'start' ? 0 : 1]?.focus(); } })))),
      h('p', { class: 'date-picker__summary', role: 'status' }, summary),
      h('div', { class: 'date-picker__actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => { close(); onChange(null); trigger.focus(); } }, 'Clear'),
        h('button', { type: 'button', class: 'btn btn--gold', disabled: !valid, onclick: () => {
          const next = { ...draft, dates: [...draft.dates] }; close(); onChange(next); trigger.focus();
        } }, 'Apply')),
    ]);
  }

  function render(selection) {
    applied = selection;
    const label = !selection ? 'Choose event dates'
      : selection.mode === 'range' ? `${formatDay(selection.start)} – ${formatDay(selection.end)}`
        : selection.dates.map(formatDay).join(', ');
    trigger.setAttribute('aria-label', !selection ? label : `Filter event dates: ${label}`);
    trigger.title = label;
    trigger.classList.toggle('date-filter__trigger--active', Boolean(selection));
  }
  document.addEventListener('pointerdown', (event) => {
    if (isOpen && !root.contains(event.target)) close();
  });
  render(null);
  return { render };
}
