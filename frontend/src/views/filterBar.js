/**
 * Filter bar: debounced text search, group select, sort order, tag chips, "Near me" toggle.
 * Stateless UI: it renders a FilterState and reports changes via onChange(patch).
 * @module views/filterBar
 */
import { createElementTree } from "../dom.js";
import {
  DEFAULT_SORT_ORDER,
  SORT_ORDERS,
  normalizeSortOrder,
  toggleTag,
} from "../filters.js";
import { debounce } from "../util.js";

/** Sort select options, in display order. */
export const SORT_OPTIONS = Object.freeze([
  Object.freeze({ value: SORT_ORDERS.SOONEST, label: "Soonest" }),
  Object.freeze({ value: SORT_ORDERS.NEWEST, label: "Newest" }),
]);

/**
 * Sort order `<select>`; reports a change as onChange({sort}).
 * @param {(patch: {sort: string}) => void} onChange
 * @returns {HTMLSelectElement}
 */
function createSortSelect(onChange) {
  return createElementTree(
    "select",
    {
      id: "f-sort",
      name: "sort",
      onchange: (changeEvent) =>
        onChange({ sort: normalizeSortOrder(changeEvent.target.value) }),
    },
    SORT_OPTIONS.map((sortOption) =>
      createElementTree(
        "option",
        { value: sortOption.value },
        sortOption.label,
      ),
    ),
  );
}

/**
 * @param {HTMLElement} root
 * @param {{onChange: (patch: Partial<import('../filters.js').FilterState>) => void,
 *   debounceMs?: number, geoSupported?: boolean}} opts
 * @returns {{render(state: import('../filters.js').FilterState,
 *   options: {tags: {value: string, count: number}[], groups: {value: string, count: number}[],
 *   nearMeBusy?: boolean}): void}}
 */
export function createFilterBar(
  root,
  { onChange, debounceMs = 300, geoSupported = true },
) {
  let state = {
    tags: [],
    group: "",
    searchText: "",
    nearMe: false,
    sort: DEFAULT_SORT_ORDER,
  };
  const emitQ = debounce((searchText) => onChange({ searchText }), debounceMs);

  const search = createElementTree("input", {
    type: "search",
    id: "f-q",
    name: "q",
    autocomplete: "off",
    placeholder: "Search events",
    oninput: (inputEvent) => emitQ(inputEvent.target.value),
  });
  const group = createElementTree("select", {
    id: "f-group",
    name: "group",
    onchange: (changeEvent) => onChange({ group: changeEvent.target.value }),
  });
  const sort = createSortSelect(onChange);
  const nearMe = createElementTree(
    "button",
    {
      type: "button",
      class: "btn btn--gold",
      "aria-pressed": "false",
      hidden: !geoSupported,
      onclick: () => onChange({ nearMe: !state.nearMe }),
    },
    "Near me",
  );
  const chips = createElementTree("ul", {
    class: "chips",
    "aria-label": "Filter by tag",
  });

  root.replaceChildren(
    createElementTree(
      "div",
      { class: "filters__row" },
      createElementTree(
        "label",
        { for: "f-group", class: "visually-hidden" },
        "Group",
      ),
      group,
      createElementTree(
        "label",
        { for: "f-q", class: "visually-hidden" },
        "Search events",
      ),
      search,
      createElementTree(
        "label",
        { for: "f-sort", class: "visually-hidden" },
        "Sort events",
      ),
      sort,
      nearMe,
    ),
    chips,
  );

  function render(
    filterState,
    { tags = [], groups = [], nearMeBusy = false } = {},
  ) {
    state = filterState;
    if (
      document.activeElement !== search &&
      search.value !== filterState.searchText
    )
      search.value = filterState.searchText;
    renderGroups(groups, filterState.group);
    sort.value = normalizeSortOrder(filterState.sort);
    nearMe.setAttribute("aria-pressed", String(filterState.nearMe));
    nearMe.textContent = nearMeBusy ? "Locating…" : "Near me";
    renderChips(tags, filterState.tags);
  }

  function renderGroups(groups, selected) {
    const options = [
      createElementTree("option", { value: "" }, "All groups"),
      ...groups.map((groupFacet) =>
        createElementTree(
          "option",
          { value: groupFacet.value },
          `${groupFacet.value} (${groupFacet.count})`,
        ),
      ),
    ];
    if (selected && !groups.some((groupFacet) => groupFacet.value === selected))
      options.push(createElementTree("option", { value: selected }, selected));
    group.replaceChildren(...options);
    group.value = selected || "";
  }

  function renderChips(tags, active) {
    const focused = document.activeElement?.dataset?.tag;
    const values = [
      ...new Set([...active, ...tags.map((tagFacet) => tagFacet.value)]),
    ];
    chips.replaceChildren(
      ...values.map((tagValue) =>
        createElementTree(
          "li",
          null,
          createElementTree(
            "button",
            {
              type: "button",
              class: "chip",
              "aria-pressed": String(active.includes(tagValue)),
              dataset: { tag: tagValue },
              onclick: () =>
                onChange({ tags: toggleTag(state.tags, tagValue) }),
            },
            `#${tagValue}`,
          ),
        ),
      ),
    );
    if (focused)
      [...chips.querySelectorAll("button")]
        .find((chipButton) => chipButton.dataset.tag === focused)
        ?.focus();
  }

  return { render };
}
