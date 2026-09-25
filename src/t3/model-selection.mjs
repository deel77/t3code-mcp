import { BridgeError } from "../errors.mjs";

const reasoningIds = ["reasoningEffort", "effort", "variant"];
const reasoningOption = (selection) => selection?.options?.find((option) => reasoningIds.includes(option.id));

export function describeSelection(selection, providers = []) {
  if (!selection?.instanceId || !selection?.model) return null;
  const provider = providers.find((item) => item.instanceId === selection.instanceId);
  return {
    provider_instance_id: selection.instanceId,
    provider: provider?.driver ?? null,
    model: selection.model,
    reasoning_level: reasoningOption(selection)?.value ?? null,
    options: selection.options ?? [],
  };
}

export function nextTurnModel(thread, providers = []) {
  const selection = describeSelection(thread.modelSelection, providers);
  return selection ? { source: "thread_configuration", ...selection } : null;
}

export function resolveModelSelection(requested, base, providers) {
  if (requested === undefined) return base;
  if (!requested || typeof requested !== "object") throw new BridgeError("model_selection must be an object.");
  let id = requested.provider_instance_id ?? base?.instanceId;
  if (requested.provider && !requested.provider_instance_id) {
    const matches = providers.filter((item) => item.driver === requested.provider && item.enabled && item.installed);
    if (!matches.some((item) => item.instanceId === id)) {
      if (matches.length !== 1) throw new BridgeError(`Provider '${requested.provider}' needs provider_instance_id because ${matches.length} instances are available.`, 400);
      id = matches[0].instanceId;
    }
  }
  const provider = providers.find((item) => item.instanceId === id);
  if (!provider) throw new BridgeError(`Unknown provider instance '${id ?? ""}'. Call list_model_options.`, 400);
  if (requested.provider && requested.provider !== provider.driver) {
    throw new BridgeError(`Provider '${requested.provider}' does not match instance '${id}' (${provider.driver}).`, 400);
  }
  if (!provider.enabled || !provider.installed) throw new BridgeError(`Provider instance '${id}' is unavailable.`, 400);
  if (id !== base?.instanceId && !requested.model) {
    throw new BridgeError("Specify model when changing provider_instance_id; the bridge will not choose a model silently.", 400);
  }
  const modelSlug = requested.model ?? base?.model;
  const model = provider.models?.find((item) => item.slug === modelSlug);
  if (!model) throw new BridgeError(`Model '${modelSlug ?? ""}' is unavailable on provider instance '${id}'. Call list_model_options.`, 400);
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const descriptor = descriptors.find((item) => reasoningIds.includes(item.id));
  const sameModel = id === base?.instanceId && modelSlug === base?.model;
  const options = sameModel ? [...(base.options ?? [])] : [];
  if (requested.reasoning_level !== undefined) {
    if (!descriptor) throw new BridgeError(`Model '${modelSlug}' has no reasoning level option.`, 400);
    if (!descriptor.options?.some((item) => item.id === requested.reasoning_level)) {
      throw new BridgeError(`Reasoning level '${requested.reasoning_level}' is unavailable for '${modelSlug}'. Valid values: ${descriptor.options?.map((item) => item.id).join(", ")}.`, 400);
    }
    const index = options.findIndex((option) => option.id === descriptor.id);
    const option = { id: descriptor.id, value: requested.reasoning_level };
    if (index < 0) options.push(option); else options[index] = option;
  }
  return { instanceId: id, model: modelSlug, ...(options.length ? { options } : {}) };
}

export function modelOptions(providers, { providerInstanceId, query, limit = 30 } = {}) {
  const matches = [];
  for (const provider of providers) {
    if (!provider.enabled || !provider.installed || (providerInstanceId && provider.instanceId !== providerInstanceId)) continue;
    for (const model of provider.models ?? []) {
      if (query && !`${model.slug} ${model.name} ${provider.instanceId}`.toLowerCase().includes(query.toLowerCase())) continue;
      const descriptor = model.capabilities?.optionDescriptors?.find((item) => reasoningIds.includes(item.id));
      matches.push({ provider_instance_id: provider.instanceId, provider: provider.driver, model: model.slug,
        model_name: model.name, reasoning_levels: descriptor?.options?.map((item) => item.id) ?? [] });
    }
  }
  return { models: matches.slice(0, limit), total: matches.length, truncated: matches.length > limit };
}
