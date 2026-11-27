/**
 * App-level subscription flows (#19), run against the real app in ?mock mode: the same
 * in-browser mock AppView (stubs/mockApi.js) and mock PDS (stubs/mockPds.js) a future
 * Playwright suite will use. Each test mirrors one of the issue's e2e scenarios.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_NSID } from "../src/lexicon/validateSubscription.js";
import {
  MOCK_PDS_STORAGE_KEY,
  mockDidForHandle,
} from "../src/stubs/mockPds.js";
import {
  SUBSCRIBED_LABEL,
  SUBSCRIBE_LABEL,
} from "../src/views/subscribeButton.js";
import { memoryStorage, testConfig, testMockConfig } from "./helpers.js";

globalThis.__CM_NO_AUTOSTART__ = true;
const { start } = await import("../src/app.js");

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const flush = () => new Promise((resolveFlush) => setTimeout(resolveFlush, 0));

const HANDLE = "larry.test";
/** Mock events (stubs/mockApi.js): one upcoming, one already ended. */
const UPCOMING_HASH = "#/event/did:plc:mockacm0000000/mock-hackathon";
const ENDED_HASH = "#/event/did:plc:mockclub0000000/mock-ended";
const UPCOMING_TITLE = "ACM Fall Hack Night";

const findElement = (selector) => document.querySelector(selector);
const subscribeButton = () =>
  findElement("#panel-detail [data-action=subscribe]");
const subscriptionsCards = () => [
  ...document.querySelectorAll("#panel-subscriptions .card h3"),
];

/** Leaflet stand-in (the map view needs window.L). */
function fakeLeaflet() {
  const fakeLayer = () => ({
    addTo() {
      return this;
    },
    bindPopup() {
      return this;
    },
    setView() {
      return this;
    },
    clearLayers() {},
    invalidateSize() {},
    fitBounds() {},
    remove() {},
  });
  return {
    map: vi.fn(fakeLayer),
    tileLayer: vi.fn(fakeLayer),
    layerGroup: vi.fn(fakeLayer),
    marker: vi.fn(fakeLayer),
  };
}

/**
 * Boot the app in ?mock mode at `hash`. Passing the same storages again simulates a
 * page reload: the session (sessionStorage) and mock PDS records (localStorage) survive.
 */
async function bootMockApp(
  hash = "",
  { local = memoryStorage(), session = memoryStorage() } = {},
) {
  history.replaceState(null, "", `/?mock${hash}`);
  document.documentElement.innerHTML = html.replace(
    /<script[^>]*><\/script>/,
    "",
  );
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("L", fakeLeaflet());
  await start({
    config: await testConfig(),
    mockConfig: await testMockConfig(),
  });
  await flush();
  await flush();
  return { local, session };
}

/** Fill in and submit the login dialog. */
async function submitLogin(handle = HANDLE, password = "app-password") {
  const form = findElement("dialog form");
  form.elements.identifier.value = handle;
  form.elements.password.value = password;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() =>
    expect(findElement("#account").textContent).toContain(handle),
  );
}

/** Log in from the header's Log in button. */
async function logInFromHeader() {
  [...document.querySelectorAll("#account button")]
    .find((button) => button.textContent === "Log in")
    .click();
  await submitLogin();
}

/** Navigate to a hash and wait for the router to react. */
async function navigateTo(hash) {
  location.hash = hash;
  await flush();
  await flush();
}

const waitForLabel = (label) =>
  vi.waitFor(() => expect(subscribeButton()?.textContent).toBe(label));

describe("subscriptions in the app (#19, ?mock)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("e2e 1: subscribe → Subscribed ✓ → listed on My subscriptions", async () => {
    await bootMockApp();
    await logInFromHeader();
    await navigateTo(UPCOMING_HASH);
    await waitForLabel(SUBSCRIBE_LABEL);
    subscribeButton().click();
    await waitForLabel(SUBSCRIBED_LABEL);
    expect(subscribeButton().getAttribute("aria-pressed")).toBe("true");

    findElement("#account [data-action=my-subscriptions]").click();
    await vi.waitFor(() =>
      expect(
        subscriptionsCards().map((heading) => heading.textContent),
      ).toEqual([UPCOMING_TITLE]),
    );
    expect(findElement("#panel-subscriptions").hidden).toBe(false);
    expect(findElement("#panel-detail").hidden).toBe(true);
  });

  it("stores the subscription as a strongRef record on the user's PDS", async () => {
    const { local } = await bootMockApp();
    await logInFromHeader();
    await navigateTo(UPCOMING_HASH);
    await waitForLabel(SUBSCRIBE_LABEL);
    subscribeButton().click();
    await waitForLabel(SUBSCRIBED_LABEL);
    const repos = JSON.parse(local.getItem(MOCK_PDS_STORAGE_KEY));
    const records = Object.values(
      repos[mockDidForHandle(HANDLE)][SUBSCRIPTION_NSID],
    );
    expect(records).toHaveLength(1);
    expect(records[0].value.subject).toEqual({
      uri: "at://did:plc:mockacm0000000/app.communitymap.event/mock-hackathon",
      cid: expect.stringMatching(/^bafy/),
    });
  });

  it("e2e 2: after a reload the button still shows Subscribed ✓", async () => {
    const storages = await bootMockApp();
    await logInFromHeader();
    await navigateTo(UPCOMING_HASH);
    await waitForLabel(SUBSCRIBE_LABEL);
    subscribeButton().click();
    await waitForLabel(SUBSCRIBED_LABEL);

    await bootMockApp(UPCOMING_HASH, storages); // reload
    await waitForLabel(SUBSCRIBED_LABEL);
  });

  it("e2e 3: clicking Subscribed ✓ unsubscribes and removes it from My subscriptions", async () => {
    await bootMockApp();
    await logInFromHeader();
    await navigateTo(UPCOMING_HASH);
    await waitForLabel(SUBSCRIBE_LABEL);
    subscribeButton().click();
    await waitForLabel(SUBSCRIBED_LABEL);
    subscribeButton().click();
    await waitForLabel(SUBSCRIBE_LABEL);

    await navigateTo("#/subscriptions");
    await vi.waitFor(() =>
      expect(findElement("#panel-subscriptions .empty")).not.toBeNull(),
    );
    expect(subscriptionsCards()).toHaveLength(0);
  });

  it("unsubscribing from My subscriptions removes the card", async () => {
    await bootMockApp();
    await logInFromHeader();
    await navigateTo(UPCOMING_HASH);
    await waitForLabel(SUBSCRIBE_LABEL);
    subscribeButton().click();
    await waitForLabel(SUBSCRIBED_LABEL);
    await navigateTo("#/subscriptions");
    await vi.waitFor(() => expect(subscriptionsCards()).toHaveLength(1));
    findElement("#panel-subscriptions [data-action=subscribe]").click();
    await vi.waitFor(() => expect(subscriptionsCards()).toHaveLength(0));
  });

  it("e2e 4: a logged-out Subscribe asks to log in, then returns to the event subscribed", async () => {
    await bootMockApp(UPCOMING_HASH);
    await waitForLabel(SUBSCRIBE_LABEL);
    subscribeButton().click();
    await flush();
    expect(findElement("#login-reason").textContent).toBe(
      "Log in to subscribe to this event.",
    );
    await submitLogin();
    expect(location.hash).toBe(UPCOMING_HASH);
    await waitForLabel(SUBSCRIBED_LABEL);
  });

  it("a logged-out Subscribe on a feed card returns to that event's page after login", async () => {
    await bootMockApp();
    const card = [...document.querySelectorAll("#list .card")].find(
      (candidateCard) => candidateCard.textContent.includes(UPCOMING_TITLE),
    );
    card.querySelector("[data-action=subscribe]").click();
    await flush();
    await submitLogin();
    await vi.waitFor(() => expect(location.hash).toBe(UPCOMING_HASH));
    await waitForLabel(SUBSCRIBED_LABEL);
  });

  it("cancelling the login dialog does not subscribe", async () => {
    await bootMockApp(UPCOMING_HASH);
    await waitForLabel(SUBSCRIBE_LABEL);
    subscribeButton().click();
    await flush();
    [...document.querySelectorAll("dialog button")]
      .find((button) => button.textContent === "Cancel")
      .click();
    await flush();
    expect(subscribeButton().textContent).toBe(SUBSCRIBE_LABEL);
  });

  it("e2e 5: an expired event shows no Subscribe button", async () => {
    await bootMockApp();
    await logInFromHeader();
    await navigateTo(ENDED_HASH);
    await vi.waitFor(() =>
      expect(findElement("#panel-detail .detail__ended")).not.toBeNull(),
    );
    expect(subscribeButton()).toBeNull();
  });

  it("My subscriptions asks logged-out users to log in", async () => {
    await bootMockApp("#/subscriptions");
    const panel = findElement("#panel-subscriptions");
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector("#subscriptions-title").textContent).toBe(
      "My subscriptions",
    );
    panel.querySelector("[data-action=login]").click();
    await flush();
    expect(findElement("#login-reason").textContent).toBe(
      "Log in to see your subscriptions.",
    );
  });

  it("logging out clears the subscribed state", async () => {
    await bootMockApp();
    await logInFromHeader();
    await navigateTo(UPCOMING_HASH);
    await waitForLabel(SUBSCRIBE_LABEL);
    subscribeButton().click();
    await waitForLabel(SUBSCRIBED_LABEL);
    [...document.querySelectorAll("#account button")]
      .find((button) => button.textContent === "Log out")
      .click();
    await waitForLabel(SUBSCRIBE_LABEL);
  });
});
