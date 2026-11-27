import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backoffMs,
  createNotifications,
  mergeNotifications,
} from "../src/notifications.js";
import { memoryStorage } from "./helpers.js";

const SUBSCRIBER_DID = "did:plc:me";

const makeNotification = (id, message = `m${id}`) => ({
  id,
  subscriberId: SUBSCRIBER_DID,
  eventUri: "at://e",
  kind: "announcement",
  message,
  createdAt: "2026-11-11T00:00:00Z",
});

class FakeES {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeES.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

/** Build a notification client with fakes for EventSource / Notification / the API. */
function setup({ storage = memoryStorage(), notifications = [] } = {}) {
  FakeES.instances = [];
  const api = {
    notifications: vi.fn(async () => ({ data: notifications, stale: false })),
    notificationStreamUrl: (id) =>
      `/api/notifications/stream?subscriberId=${id}`,
  };
  const toast = vi.fn();
  const onNotification = vi.fn();
  const NotificationImpl = Object.assign(vi.fn(), {
    permission: "default",
    requestPermission: vi.fn(async () => "granted"),
  });
  const client = createNotifications({
    api,
    storage,
    EventSourceImpl: FakeES,
    NotificationImpl,
    toast,
    onNotification,
    baseDelayMs: 10,
  });
  return { api, toast, onNotification, client, storage, NotificationImpl };
}

const flush = () => new Promise((resolveFlush) => setTimeout(resolveFlush, 0));

describe("mergeNotifications", () => {
  it("keeps only newer, deduped, sorted; advances lastId", () => {
    expect(
      mergeNotifications(5, [
        makeNotification(7),
        makeNotification(4),
        makeNotification(6),
        makeNotification(7),
        makeNotification(5),
      ]),
    ).toEqual({
      fresh: [makeNotification(6), makeNotification(7)],
      lastId: 7,
    });
    expect(mergeNotifications(5, [])).toEqual({ fresh: [], lastId: 5 });
    expect(
      mergeNotifications(null, [makeNotification(2), makeNotification(1)])
        .lastId,
    ).toBe(2);
  });

  it("ignores malformed lists and entries", () => {
    expect(mergeNotifications(1, null)).toEqual({ fresh: [], lastId: 1 });
    expect(
      mergeNotifications(null, [null, { id: "7" }, makeNotification(3)]).fresh,
    ).toEqual([makeNotification(3)]);
  });

  it("backoff doubles and caps", () => {
    expect(
      [0, 1, 2, 10].map((attempt) => backoffMs(attempt, 1000, 30000)),
    ).toEqual([1000, 2000, 4000, 30000]);
  });
});

describe("createNotifications", () => {
  afterEach(() => vi.useRealTimers());

  it("connects only while watching a DID, and keys the stream by it", () => {
    const { client } = setup();
    expect(FakeES.instances).toHaveLength(0);
    client.watch(SUBSCRIBER_DID);
    expect(FakeES.instances).toHaveLength(1);
    expect(FakeES.instances[0].url).toContain(`subscriberId=${SUBSCRIBER_DID}`);
    expect(client.subscriberId).toBe(SUBSCRIBER_DID);
    client.watch(SUBSCRIBER_DID); // same DID: no second connection
    expect(FakeES.instances).toHaveLength(1);
    client.watch(null);
    expect(FakeES.instances[0].closed).toBe(true);
    expect(client.subscriberId).toBeNull();
  });

  it("reconnects when the watched DID changes (account switch)", () => {
    const { client } = setup();
    client.watch(SUBSCRIBER_DID);
    client.watch("did:plc:other");
    expect(FakeES.instances[0].closed).toBe(true);
    expect(FakeES.instances[1].url).toContain("subscriberId=did:plc:other");
  });

  it.each(["", 42, undefined])("treats %j as not watching", (id) => {
    const { client } = setup();
    client.watch(id);
    expect(FakeES.instances).toHaveLength(0);
  });

  it("toasts stream messages and passes them on", () => {
    const { client, toast, onNotification } = setup();
    client.watch(SUBSCRIBER_DID);
    FakeES.instances[0].onmessage({
      data: JSON.stringify(makeNotification(1, "Room changed")),
    });
    expect(toast).toHaveBeenCalledWith("Room changed");
    expect(onNotification).toHaveBeenCalledWith(
      makeNotification(1, "Room changed"),
    );
    FakeES.instances[0].onmessage({ data: "not json" });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("first connect records a baseline silently, per DID", async () => {
    const { client, toast, api, storage } = setup({
      notifications: [makeNotification(3), makeNotification(4)],
    });
    client.watch(SUBSCRIBER_DID);
    FakeES.instances[0].onopen();
    await flush();
    expect(api.notifications).toHaveBeenCalledWith(SUBSCRIBER_DID, null);
    expect(toast).not.toHaveBeenCalled();
    expect(storage.getItem(`cm:last-notification-id:${SUBSCRIBER_DID}`)).toBe(
      "4",
    );
  });

  it("on reconnect, catches up via since=<lastId> without duplicating stream messages", async () => {
    vi.useFakeTimers();
    const { client, toast, api } = setup();
    client.watch(SUBSCRIBER_DID);
    const firstEventSource = FakeES.instances[0];
    firstEventSource.onmessage({ data: JSON.stringify(makeNotification(10)) });
    firstEventSource.onerror();
    expect(firstEventSource.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    const secondEventSource = FakeES.instances[1];
    expect(secondEventSource).toBeDefined();
    api.notifications.mockResolvedValueOnce({
      data: [makeNotification(10), makeNotification(11), makeNotification(12)],
      stale: false,
    });
    secondEventSource.onopen();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.notifications).toHaveBeenLastCalledWith(SUBSCRIBER_DID, 10);
    expect(toast.mock.calls.map((call) => call[0])).toEqual([
      "m10",
      "m11",
      "m12",
    ]);
    secondEventSource.onmessage({ data: JSON.stringify(makeNotification(12)) });
    expect(toast).toHaveBeenCalledTimes(3);
  });

  it("survives a missing notifications endpoint (STUB #5)", async () => {
    const { client, api, toast } = setup();
    api.notifications.mockRejectedValue(new Error("404"));
    client.watch(SUBSCRIBER_DID);
    FakeES.instances[0].onopen();
    await flush();
    expect(toast).not.toHaveBeenCalled();
  });

  it("does nothing without EventSource support", () => {
    const client = createNotifications({
      api: { notificationStreamUrl: () => "x" },
      storage: memoryStorage(),
      EventSourceImpl: null,
    });
    expect(() => client.watch(SUBSCRIBER_DID)).not.toThrow();
  });

  it("asks for notification permission only once per browser", async () => {
    const { client, NotificationImpl } = setup();
    await client.askPermissionOnce();
    await client.askPermissionOnce();
    expect(NotificationImpl.requestPermission).toHaveBeenCalledTimes(1);
  });
});
