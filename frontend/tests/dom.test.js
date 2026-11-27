import { describe, expect, it, vi } from "vitest";
import { createElementTree, safeHttpUrl } from "../src/dom.js";

describe("createElementTree()", () => {
  it("escapes text children and sets attributes/handlers", () => {
    const clickHandler = vi.fn();
    const button = createElementTree(
      "button",
      {
        class: "b",
        "aria-pressed": "true",
        onclick: clickHandler,
        dataset: { testKey: "testValue" },
      },
      "<img src=x onerror=alert(1)>",
      null,
      ["a", 1],
    );
    expect(button.querySelector("img")).toBeNull();
    expect(button.textContent).toBe("<img src=x onerror=alert(1)>a1");
    expect(button.className).toBe("b");
    expect(button.dataset.testKey).toBe("testValue");
    button.click();
    expect(clickHandler).toHaveBeenCalled();
  });

  it("safeHttpUrl allows only http(s)", () => {
    expect(safeHttpUrl("https://ucsd.edu/x")).toBe("https://ucsd.edu/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});
