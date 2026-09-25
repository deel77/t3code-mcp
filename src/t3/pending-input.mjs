import { BridgeError } from "../errors.mjs";

const staleRequestFragments = [
  "stale pending user-input request",
  "unknown pending user-input request",
  "unknown pending user input request",
  "unknown pending codex user input request",
];

function parseQuestion(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string"
    || typeof value.question !== "string" || !Array.isArray(value.options)) return null;
  const options = value.options.flatMap((option) => {
    if (!option || typeof option.label !== "string") return [];
    return [{
      label: option.label,
      description: typeof option.description === "string" ? option.description : "",
      value: typeof option.value === "string" ? option.value : option.label,
    }];
  });
  if (options.length === 0 && value.allowCustomAnswer === false) return null;
  return {
    id: value.id,
    header: typeof value.header === "string" ? value.header : value.question,
    question: value.question,
    options,
    allow_custom_answer: value.allowCustomAnswer !== false,
    multi_select: value.multiSelect === true,
  };
}

export function pendingUserInputs(activities) {
  const open = new Map();
  const closed = new Set();
  for (const activity of activities ?? []) {
    const payload = activity?.payload;
    const requestId = payload && typeof payload === "object" ? payload.requestId : null;
    if (typeof requestId !== "string" || !requestId) continue;
    if (activity.kind === "user-input.requested") {
      if (closed.has(requestId) || !Array.isArray(payload.questions)) continue;
      const questions = payload.questions.map(parseQuestion).filter(Boolean);
      if (questions.length === 0) continue;
      open.set(requestId, {
        request_id: requestId,
        created_at: activity.createdAt,
        response_mode: payload.responseMode === "message" ? "message" : "callback",
        questions,
      });
    } else if (activity.kind === "user-input.resolved" || (
      activity.kind === "provider.user-input.respond.failed"
      && typeof payload.detail === "string"
      && staleRequestFragments.some((fragment) => payload.detail.toLowerCase().includes(fragment))
    )) {
      closed.add(requestId);
      open.delete(requestId);
    }
  }
  return [...open.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function validateInputAnswers(request, submitted) {
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
    throw new BridgeError("answers must be an object keyed by question ID.");
  }
  const questionIds = new Set(request.questions.map((question) => question.id));
  for (const id of Object.keys(submitted)) {
    if (!questionIds.has(id)) throw new BridgeError(`Unknown question ID: ${id}.`);
  }
  const answers = Object.create(null);
  for (const question of request.questions) {
    if (!Object.hasOwn(submitted, question.id)) {
      throw new BridgeError(`Missing answer for question ID: ${question.id}.`);
    }
    const answer = submitted[question.id];
    const allowedValues = new Set(question.options.map((option) => option.value));
    if (Array.isArray(answer)) {
      if (!question.multi_select || answer.length === 0 || answer.length > question.options.length
        || answer.some((value) => typeof value !== "string" || !allowedValues.has(value))) {
        throw new BridgeError(`Invalid choices for question ID: ${question.id}.`);
      }
      const values = [...new Set(answer)];
      answers[question.id] = request.response_mode === "message" ? values.join(", ") : values;
      continue;
    }
    if (typeof answer !== "string" || answer.length > 4_000) {
      throw new BridgeError(`Invalid answer for question ID: ${question.id}.`);
    }
    const selectedOption = allowedValues.has(answer);
    if (!selectedOption && (!question.allow_custom_answer || !answer.trim())) {
      throw new BridgeError(`Answer is not an allowed choice for question ID: ${question.id}.`);
    }
    answers[question.id] = answer;
  }
  return answers;
}
