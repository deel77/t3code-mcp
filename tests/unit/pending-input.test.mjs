import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError } from "../../src/errors.mjs";
import { pendingUserInputs, validateInputAnswers } from "../../src/t3/pending-input.mjs";

test("resolved questions cannot be answered again, and answer values are validated", () => {
  const question = { id: "choice", question: "Choose one", options: [{ label: "SQLite", value: "sqlite" }], allowCustomAnswer: false };
  const requested = { kind: "user-input.requested", createdAt: "2025-01-02T00:00:00Z", payload: { requestId: "r1", questions: [question] } };
  const [pending] = pendingUserInputs([requested]);
  assert.deepEqual({ ...validateInputAnswers(pending, { choice: "sqlite" }) }, { choice: "sqlite" });
  assert.throws(() => validateInputAnswers(pending, { choice: "postgres" }), BridgeError);
  assert.throws(() => validateInputAnswers(pending, {}), BridgeError);
  assert.equal(pendingUserInputs([requested, { kind: "user-input.resolved", payload: { requestId: "r1" } }]).length, 0);
  assert.equal(pendingUserInputs([{ kind: "user-input.resolved", payload: { requestId: "r1" } }, requested]).length, 0);
});
