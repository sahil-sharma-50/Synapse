import { describe, expect, it } from "vitest";
import { formatBytes, formatEta } from "./modelDownload";

describe("formatBytes", () => {
  it("uses MB below a gigabyte, because '0.7 GB' reads worse than '690 MB'", () => {
    expect(formatBytes(690 * 1024 ** 2)).toBe("690 MB");
    expect(formatBytes(1024 ** 3 - 1)).toMatch(/MB$/);
  });

  it("switches to GB at exactly one gigabyte", () => {
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.3 GB");
  });

  it("renders a zero total without NaN", () => {
    expect(formatBytes(0)).toBe("0 MB");
  });
});

describe("formatEta", () => {
  it("is empty when the rate has not settled, rather than showing Infinity", () => {
    expect(formatEta(Infinity)).toBe("");
    expect(formatEta(NaN)).toBe("");
    expect(formatEta(0)).toBe("");
    expect(formatEta(-5)).toBe("");
  });

  it("counts seconds under a minute", () => {
    expect(formatEta(1)).toBe("1s left");
    expect(formatEta(59.2)).toBe("60s left");
  });

  it("counts minutes under an hour", () => {
    expect(formatEta(60)).toBe("1 min left");
    expect(formatEta(59 * 60)).toBe("59 min left");
  });

  it("counts hours beyond that", () => {
    expect(formatEta(60 * 60)).toBe("1 hr left");
    expect(formatEta(150 * 60)).toBe("3 hr left");
  });
});
