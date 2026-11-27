import { describe, expect, it, vi } from "vitest";
import {
  PRIVACY_NOTE_ID,
  SUBSCRIBED_LABEL,
  SUBSCRIBE_LABEL,
  SUBSCRIPTION_PRIVACY_NOTE,
  UNSUBSCRIBE_HINT,
  renderPrivacyNote,
  renderSubscribeButton,
} from "../src/views/subscribeButton.js";
import { sampleEvent } from "./helpers.js";

describe("renderSubscribeButton", () => {
  it("shows Subscribe with the privacy tooltip when not subscribed", () => {
    const button = renderSubscribeButton(sampleEvent());
    expect(button.textContent).toBe(SUBSCRIBE_LABEL);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.title).toBe(SUBSCRIPTION_PRIVACY_NOTE);
    expect(button.dataset.action).toBe("subscribe");
    expect(button.className).toBe("btn btn--primary");
  });

  it("shows Subscribed ✓ with an unsubscribe hint when subscribed", () => {
    const button = renderSubscribeButton(sampleEvent(), { subscribed: true });
    expect(button.textContent).toBe("Subscribed ✓");
    expect(button.textContent).toBe(SUBSCRIBED_LABEL);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.title).toContain(UNSUBSCRIBE_HINT);
    expect(button.className).toBe("btn btn--on");
  });

  it("hides the button for ended events unless already subscribed", () => {
    expect(renderSubscribeButton(sampleEvent(), { ended: true })).toBeNull();
    expect(
      renderSubscribeButton(sampleEvent(), { ended: true, subscribed: true }),
    ).not.toBeNull();
  });

  it("passes the whole event to onToggle", () => {
    const onToggle = vi.fn();
    const event = sampleEvent();
    renderSubscribeButton(event, { onToggle }).click();
    expect(onToggle).toHaveBeenCalledWith(event);
  });

  it("supports the plain variant, extra data attributes and aria-describedby", () => {
    const button = renderSubscribeButton(sampleEvent(), {
      variant: "plain",
      dataset: { focusKey: "sub:x" },
      describedBy: PRIVACY_NOTE_ID,
    });
    expect(button.className).toBe("btn");
    expect(button.dataset).toMatchObject({
      action: "subscribe",
      focusKey: "sub:x",
    });
    expect(button.getAttribute("aria-describedby")).toBe(PRIVACY_NOTE_ID);
  });

  it("falls back to primary for an unknown variant and survives no handler", () => {
    const button = renderSubscribeButton(sampleEvent(), { variant: "fancy" });
    expect(button.className).toBe("btn btn--primary");
    expect(() => button.click()).not.toThrow();
  });
});

describe("renderPrivacyNote", () => {
  it("renders the note with the default or a custom id", () => {
    expect(renderPrivacyNote().id).toBe(PRIVACY_NOTE_ID);
    expect(renderPrivacyNote("x").id).toBe("x");
    expect(renderPrivacyNote().textContent).toBe(SUBSCRIPTION_PRIVACY_NOTE);
  });
});
