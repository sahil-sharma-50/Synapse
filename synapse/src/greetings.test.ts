import { afterEach, expect, it, vi } from "vitest";
import { chooseGreeting, DEFAULT_GREETINGS } from "./greetings";

afterEach(() => vi.restoreAllMocks());

it("selects every default greeting and falls back for blank custom text", () => {
  const random = vi.spyOn(Math, "random");
  DEFAULT_GREETINGS.forEach((greeting, index) => {
    random.mockReturnValue((index + 0.5) / DEFAULT_GREETINGS.length);
    expect(chooseGreeting()).toBe(greeting);
    expect(chooseGreeting(" \r\n\n ")).toBe(greeting);
  });
});

it("uses only nonempty custom greetings, including Windows line endings", () => {
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  expect(chooseGreeting("  Hello, Sahil! \r\n\r\n Welcome back.  ")).toBe("Hello, Sahil!");
  random.mockReturnValue(0.999999);
  expect(chooseGreeting("  Hello, Sahil! \r\n\r\n Welcome back.  ")).toBe("Welcome back.");
  expect(chooseGreeting(" My only greeting ")).toBe("My only greeting");
});
