/**
 * Create / edit event form in a <dialog>, validated client-side against the event
 * record's schema (its lexicon, lexicons/app/communitymap/event.json).
 * @module views/composeView
 */
import { closeDialog, createElementTree, openDialog } from "../dom.js";
import {
  buildEventRecord,
  parseAtUri,
  validateEventRecord,
  validateHashtag,
} from "../records.js";
import { runInBackground } from "../util.js";

/**
 * ISO timestamp → value for <input type="datetime-local"> in local time.
 * @param {string} isoDateTime
 * @returns {string}
 */
export function isoToLocalInput(isoDateTime) {
  if (!isoDateTime) return "";
  const date = new Date(isoDateTime);
  const padToTwoDigits = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${padToTwoDigits(date.getMonth() + 1)}-${padToTwoDigits(date.getDate())}T${padToTwoDigits(date.getHours())}:${padToTwoDigits(date.getMinutes())}`;
}

/**
 * datetime-local value (local time) → ISO string, or "" if empty/invalid.
 * @param {string} value
 * @returns {string}
 */
export function localInputToIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

const FIELDS = [
  "name",
  "description",
  "startsAt",
  "endsAt",
  "locationName",
  "address",
  "lat",
  "lng",
  "tags",
  "group",
  "hashtag",
];

/**
 * Read raw values from the compose form.
 * @param {HTMLFormElement} form
 * @returns {Record<string, string>}
 */
export function readForm(form) {
  return Object.fromEntries(
    FIELDS.map((fieldName) => [
      fieldName,
      form.elements[fieldName]?.value ?? "",
    ]),
  );
}

/**
 * Turn form values into a record and validate it.
 * Error keys are form field names (coords errors are reported on "lat").
 * @param {Record<string, string>} values
 * @param {{createdAt?: string, sourceUrl?: string}} [base] preserved fields when editing
 * @returns {{record: object, errors: Record<string, string>}}
 */
export function validateForm(values, base = {}) {
  const record = buildEventRecord({
    ...values,
    startsAt: localInputToIso(values.startsAt),
    endsAt: localInputToIso(values.endsAt),
    createdAt: base.createdAt,
    sourceUrl: base.sourceUrl,
  });
  const errors = validateEventRecord(record);
  const partialCoords =
    Boolean(values.lat?.trim()) !== Boolean(values.lng?.trim());
  if (partialCoords)
    errors.coords = "Enter both latitude and longitude, or neither.";
  if (errors.coords) {
    errors.lat = errors.coords;
    delete errors.coords;
  }
  const tagError = validateHashtag(values.hashtag);
  if (tagError) errors.hashtag = tagError;
  return { record, errors };
}

function field(name, label, input, hint) {
  input.id = `c-${name}`;
  input.name = name;
  return createElementTree(
    "div",
    { class: "field" },
    createElementTree("label", { for: input.id }, label),
    hint &&
      createElementTree("p", { class: "hint", id: `c-${name}-hint` }, hint),
    input,
    createElementTree("p", { class: "field__error", id: `c-${name}-err` }),
  );
}

/**
 * Show errors next to fields (aria-invalid + aria-describedby) and focus the first one.
 * @param {HTMLFormElement} form
 * @param {Record<string, string>} errors
 */
export function showErrors(form, errors) {
  for (const fieldName of FIELDS) {
    const input = form.elements[fieldName];
    const error = form.querySelector(`#c-${fieldName}-err`);
    if (!input || !error) continue;
    const message = errors[fieldName] || "";
    error.textContent = message;
    input.setAttribute("aria-invalid", String(Boolean(message)));
    const hint = form.querySelector(`#c-${fieldName}-hint`)
      ? `c-${fieldName}-hint `
      : "";
    input.setAttribute("aria-describedby", `${hint}c-${fieldName}-err`.trim());
  }
  const firstInvalidField = FIELDS.find((fieldName) => errors[fieldName]);
  if (firstInvalidField) form.elements[firstInvalidField].focus();
}

/**
 * Build the compose form element (pre-filled when editing).
 * @param {object|null} event EventView being edited, or null for a new event
 * @returns {HTMLFormElement}
 */
export function buildForm(event) {
  const eventLocation = event?.location || {};
  const input = (attributes) => createElementTree("input", attributes);
  return createElementTree(
    "form",
    { class: "compose", novalidate: true },
    field(
      "name",
      "Event name",
      input({ required: true, maxlength: 200, value: event?.name ?? "" }),
    ),
    field(
      "description",
      "Description",
      createElementTree("textarea", {
        rows: 4,
        maxlength: 3000,
        value: event?.description ?? "",
      }),
    ),
    createElementTree(
      "div",
      { class: "field-row" },
      field(
        "startsAt",
        "Starts",
        input({
          type: "datetime-local",
          required: true,
          value: isoToLocalInput(event?.startsAt),
        }),
      ),
      field(
        "endsAt",
        "Ends",
        input({
          type: "datetime-local",
          required: true,
          value: isoToLocalInput(event?.endsAt),
        }),
      ),
    ),
    field(
      "locationName",
      "Location name",
      input({
        required: true,
        maxlength: 200,
        value: eventLocation.name ?? "",
        placeholder: "Price Center East",
      }),
    ),
    field(
      "address",
      "Address (optional)",
      input({ maxlength: 300, value: eventLocation.address ?? "" }),
    ),
    createElementTree(
      "div",
      { class: "field-row" },
      field(
        "lat",
        "Latitude (optional)",
        input({ inputmode: "decimal", value: eventLocation.lat ?? "" }),
      ),
      field(
        "lng",
        "Longitude (optional)",
        input({ inputmode: "decimal", value: eventLocation.lng ?? "" }),
      ),
    ),
    createElementTree(
      "button",
      { type: "button", class: "btn", dataset: { action: "locate" } },
      "Use my location",
    ),
    field(
      "tags",
      "Tags",
      input({
        value: (event?.tags || []).join(", "),
        placeholder: "free food, music",
      }),
      "Comma-separated, up to 10.",
    ),
    field(
      "group",
      "Group / org (optional)",
      input({ maxlength: 100, value: event?.group ?? "" }),
    ),
    field(
      "hashtag",
      "Sync from Bluesky hashtag (optional)",
      input({ maxlength: 64, placeholder: "ucsdhackathon" }),
      "Your Bluesky posts with this hashtag appear as updates on the event.",
    ),
    createElementTree("p", { class: "form-status", role: "status" }),
    createElementTree(
      "div",
      { class: "card__actions" },
      createElementTree(
        "button",
        { type: "submit", class: "btn btn--primary" },
        event ? "Save changes" : "Create event",
      ),
      event &&
        createElementTree(
          "button",
          {
            type: "button",
            class: "btn btn--danger",
            dataset: { action: "delete" },
          },
          "Delete",
        ),
      createElementTree(
        "button",
        { type: "button", class: "btn", dataset: { action: "cancel" } },
        "Cancel",
      ),
    ),
  );
}

/**
 * Create the compose dialog controller.
 * @param {{getWriter: () => object|null, geo?: {request(): Promise<{lat: number, lng: number}>},
 *   onSaved?: (r: {uri: string}) => void, onDeleted?: (uri: string) => void,
 *   toast?: (message: string, o?: object) => void, confirmImpl?: (message: string) => boolean}} deps
 * @returns {{open(event?: object|null): void, remove(event: object): Promise<void>, element: HTMLDialogElement}}
 */
export function createComposeView({
  getWriter,
  geo,
  onSaved,
  onDeleted,
  toast = () => {},
  confirmImpl = (message) => globalThis.confirm(message),
}) {
  const dialog = createElementTree("dialog", {
    class: "dialog",
    "aria-labelledby": "compose-title",
  });

  function open(event = null) {
    const form = buildForm(event);
    const status = form.querySelector(".form-status");
    form.addEventListener("submit", (submitEvent) => {
      submitEvent.preventDefault();
      runInBackground(submit(form, event, status), "Saving the event");
    });
    form.querySelector("[data-action=cancel]").onclick = () =>
      closeDialog(dialog);
    form.querySelector("[data-action=locate]").onclick = () =>
      locate(form, status);
    const deleteButton = form.querySelector("[data-action=delete]");
    if (deleteButton) deleteButton.onclick = () => remove(event);
    dialog.replaceChildren(
      createElementTree(
        "h2",
        { id: "compose-title" },
        event ? "Edit event" : "New event",
      ),
      form,
    );
    openDialog(dialog);
  }

  async function locate(form, status) {
    try {
      const position = await geo.request();
      form.elements.lat.value = position.lat.toFixed(6);
      form.elements.lng.value = position.lng.toFixed(6);
    } catch (error) {
      status.textContent = error.message;
    }
  }

  async function submit(form, event, status) {
    const values = readForm(form);
    const { record, errors } = validateForm(
      values,
      event
        ? {
            createdAt: event.createdAt ?? event.indexedAt,
            sourceUrl: event.sourceUrl,
          }
        : {},
    );
    showErrors(form, errors);
    if (Object.keys(errors).length) return;
    const writer = getWriter();
    if (!writer) return void (status.textContent = "Log in to post events.");
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    status.textContent = "Saving…";
    try {
      const response = event
        ? await writer.updateEvent(parseAtUri(event.uri).recordKey, record)
        : await writer.createEvent(record);
      if (values.hashtag.trim())
        await writer.createListener(response.uri, values.hashtag);
      closeDialog(dialog);
      onSaved?.(response);
    } catch (error) {
      status.textContent = `Could not save: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  async function remove(event) {
    const writer = getWriter();
    if (!writer || !confirmImpl(`Delete “${event.name}”?`)) return;
    try {
      await writer.deleteEvent(parseAtUri(event.uri).recordKey);
      closeDialog(dialog);
      onDeleted?.(event.uri);
    } catch (error) {
      toast(`Could not delete: ${error.message}`, { kind: "error" });
    }
  }

  return { open, remove, element: dialog };
}
