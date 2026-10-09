import test from "node:test";
import assert from "node:assert/strict";
import { validateRequest, safeUrl, needsApproval, searchUrl, downloadResponse } from "../policy.js";
test("invalid navigation URLs explain how to recover", () => {
  for (const value of [undefined, "", "example.com", "search for cats"])
    assert.throws(() => safeUrl(value), /complete.*https:\/\//i);
});

test("rejects code, credential URLs, unknown commands and stale generations", () => {
  assert.throws(() => safeUrl("javascript:alert(1)"));
  assert.throws(() => safeUrl("https://user:secret@example.com"));
  assert.throws(() =>
    validateRequest({ version: 1, id: 1, generation: 2, command: "evaluate", params: {} }),
  );
  assert.throws(() =>
    validateRequest(
      { version: 1, id: 1, generation: 2, command: "click", params: { element: "a", snapshot: 1 } },
      3,
    ),
  );
  assert.throws(() =>
    validateRequest(
      {
        version: 1,
        id: 1,
        generation: 2,
        command: "fill",
        params: { element: "a", snapshot: 1, text: "x", approved: true },
      },
      2,
    ),
  );
});
test("reviews form submission and unknown effects, permits routine search and navigation", () => {
  assert.equal(needsApproval("click", { name: "Submit", role: "button", submit: true }), true);
  assert.equal(needsApproval("click", { name: "Send", role: "button" }), true);
  assert.equal(needsApproval("click", { name: "Search", role: "button", search: true }), false);
  assert.equal(
    needsApproval("click", { name: "Learn more", role: "link", href: "https://example.com" }),
    false,
  );
  assert.equal(needsApproval("click", { name: "Mystery", role: "button" }), true);
  assert.equal(needsApproval("press_key", { search: false }), true);
});
test("search terms are encoded as data", () => {
  assert.equal(new URL(searchUrl("a & b?#", "google")).searchParams.get("q"), "a & b?#");
  assert.equal(new URL(searchUrl("cats", "youtube")).hostname, "www.youtube.com");
});
test("document responses that would download are handed off", () => {
  assert.equal(
    downloadResponse({
      responseStatusCode: 200,
      responseHeaders: [
        { name: "Content-Disposition", value: 'attachment; filename="report.csv"' },
      ],
    }),
    true,
  );
  assert.equal(
    downloadResponse({
      responseStatusCode: 200,
      responseHeaders: [{ name: "content-type", value: "application/octet-stream" }],
    }),
    true,
  );
  assert.equal(
    downloadResponse({
      responseStatusCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
    }),
    false,
  );
  assert.equal(downloadResponse({ responseStatusCode: 302, responseHeaders: [] }), false);
});
