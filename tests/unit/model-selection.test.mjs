import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveModelSelection } from "../../src/t3/model-selection.mjs";

test("model overrides use exact live provider, model and reasoning combinations", () => {
  const providers = [{ instanceId: "provider-example", driver: "codex", enabled: true, installed: true,
    models: [{ slug: "model-example", capabilities: { optionDescriptors: [{ id: "reasoningEffort",
      options: [{ id: "low" }, { id: "high" }] }] } }] }];
  const base = { instanceId: "provider-example", model: "model-example", options: [{ id: "reasoningEffort", value: "low" }] };
  assert.deepEqual(resolveModelSelection({ provider: "codex", model: "model-example", reasoning_level: "high" }, base, providers),
    { instanceId: "provider-example", model: "model-example", options: [{ id: "reasoningEffort", value: "high" }] });
  assert.throws(() => resolveModelSelection({ model: "unknown" }, base, providers), /unavailable/);
  assert.throws(() => resolveModelSelection({ reasoning_level: "ultra" }, base, providers), /Valid values: low, high/);
  assert.throws(() => resolveModelSelection({ provider: "claudeAgent" }, base, providers), /provider_instance_id/);
});
