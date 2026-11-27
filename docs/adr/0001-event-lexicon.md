# ADR 0001: Event Lexicon Schema (`app.communitymap.event`)

## Status

Accepted (2026-11-26)

## Context

Triton Event Feed stores each event as a record in its host's PDS (Personal Data Server) on AT Protocol. A **lexicon** is the JSON schema that defines what an event record looks like. Several issues depend on it: the indexer (#5), the create-event form (#6), publishing (#8) and groups (#17).

Two constraints shape the decision:

1. **Lexicon evolution rules.** Records live in many users' PDSs, so old data can never be fixed. After a schema is in use, new fields must be optional, and we can never rename or remove a field, change its type, or change a size limit. Old data must pass the new rules, and new data must pass the old rules. Names and limits have to be right from the start.
2. **Our stack.** The frontend is JavaScript (Vite) and the backend is Python. Issue #2 asks for one shared TypeScript validator, but that code can't run in both places.

We need every event to have a name, a start and end time, and a location that can be placed on a map. We also need tags and a link to a group.

## Options Considered

**A. Adopt `community.lexicon.calendar.event` as is.** Rejected:
- Only `name` and `createdAt` are required. `startsAt`, `endsAt` and location are optional, but we need all three.
- It has no length limits, and the evolution rules don't let us add them later.
- It has no `tags` or `group` field.
- `locations` is an open union of 5 location types, which is complicated to render on a map.

**B. Use the community lexicon and add our own fields to it.** Rejected: the AT Protocol spec discourages third parties from adding fields to someone else's lexicon, because our field names could clash with ones the owners add later.

**C. Reuse the prototype lexicon (`community-map`) unchanged.** Rejected:
- `group` was a plain string, so it couldn't point at a real group record.
- `lat`/`lng` were optional (and `location.name` was required), which is backwards for a map.
- It had no `maxGraphemes` limits, so the form's character counters would be inaccurate.

**D. Our own lexicon based on the prototype, using the community lexicon's field names.** Chosen.

## Decision

We define our own lexicon, **`app.communitymap.event`**, at `lexicons/app/communitymap/event.json`.

- **NSID:** `app.communitymap` is a placeholder because this is a class project. If it were ever published, we'd need to switch to a domain the team owns.
- **Field names** match `community.lexicon.calendar.event` (`name`, `description`, `startsAt`, `endsAt`, `createdAt`) so the two stay similar.
- **Required:** `name`, `startsAt`, `endsAt`, `location` (with `lat` and `lng`), `createdAt`.
- **Optional:** `description`, `tags`, `group`, `location.name`, `location.address`.
- **Record key:** `tid` (a timestamp-based ID).
- The prototype's `sourceUrl` is dropped. We can add it later as an optional field, but we could never remove it.

**Limits** (byte `maxLength` is 10× the grapheme limit, following Bluesky's convention):

| Field | Limit |
|---|---|
| `name` | 1–100 graphemes |
| `description` | 3000 graphemes |
| `tags` | at most 10, each 1–32 graphemes |
| `location.name` | 100 graphemes |
| `location.address` | 300 graphemes |
| `location.lat` / `location.lng` | strings, at most 16 bytes each |

**`lat`/`lng` are decimal strings** (e.g. `"32.8801"`) because lexicons have no float type. This matches `community.lexicon.location.geo`.

**`group` is a `com.atproto.repo.strongRef`** (`uri` + `cid`) that points at an `app.communitymap.group` record (defined in #17).

### Validation

- **The lexicon JSON is the single source of truth.**
- **Frontend (JS):** validates with `@atproto/lexicon`, which reads the JSON file directly, so it can't drift from the schema.
- **Backend (Python):** has its own validator that reads its limits from the same JSON file.
- **Shared fixtures:** both test suites run the same example records in `fixtures/event/` (valid and invalid), so the two validators must agree.
- This differs from the issue's "one shared TypeScript validator" because the backend is Python.
- **Rules the lexicon can't express** live in the validator code: `endsAt` must be after `startsAt`, `lat` must be in -90 to 90, and `lng` must be in -180 to 180.
- **"Start can't be in the past" is a form-only rule** (#6). If the validator checked it, every past event would become invalid.

## Consequences

- **We must follow the evolution rules from now on:** new fields must be optional, and we can't rename or remove fields, change their types, or change their limits.
- **The PDS does not validate our lexicon.** It doesn't know our schema, so it accepts any record (optimistic validation). The client that publishes (#8) and the indexer (#5) must run our validators. #8 should not pass `validate: true` to `createRecord`.
- **A strongRef pins one exact version of the group record** (through its `cid`). If the group record is edited later, the event still points at the old version. Code that shows group info should look up the latest record by `uri`.
- We maintain two validators instead of one. The shared fixtures keep them in sync: any new rule needs a fixture, and both test suites must pass it.
- Clients that understand `community.lexicon.calendar.event` won't read our records automatically, but the matching field names make it easy to convert between the two.

## Future Work

- **A converter to and from `community.lexicon.calendar.event`** for syncing with other calendar apps.
  - **Outbound (ours → community) is easy:** our records always have the fields the community lexicon expects (name, times, and a location it can represent as a geo point). Only `tags` and `group` have no equivalent and would be dropped.
  - **Inbound (community → ours) is harder:** community events may have no end time or no coordinates, which our schema requires. The converter would have to fill in defaults (e.g. a default event length) or skip those events.
