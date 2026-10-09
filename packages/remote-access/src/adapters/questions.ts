import { createHash } from "node:crypto";
import {
  BridgeError,
  PreflightError,
  assertContract,
  record,
  type QuestionRequest,
  type QuestionField,
  type QuestionAnswers,
  type QuestionOption,
} from "../contract/index.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value))
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
const limited = (v: unknown, n: number): v is string =>
  typeof v === "string" && Buffer.byteLength(v) <= n;
export function normalizeQuestion(
  value: unknown,
  sessionId: string,
): QuestionRequest {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !/^[-\w]{1,200}$/.test(value.id)
  )
    throw new BridgeError("INVALID_UPSTREAM", 502);
  if (value.sessionID !== sessionId) throw new BridgeError("NOT_FOUND", 404);
  const result: QuestionRequest = {
    id: value.id,
    sessionId,
    revision: createHash("sha256").update(canonical(value)).digest("hex"),
    supported: false,
    reason: "Complete this request in OpenWork on your computer.",
    fields: [],
  };
  if (
    !record(value.metadata) ||
    value.metadata.kind !== "question" ||
    !Array.isArray(value.fields) ||
    !value.fields.length ||
    value.fields.length > 32
  )
    return result;
  const fields: QuestionField[] = [];
  const keys = new Set<string>();
  for (const field of value.fields) {
    if (
      !record(field) ||
      !limited(field.key, 200) ||
      !field.key ||
      keys.has(field.key) ||
      !["string", "multiselect"].includes(String(field.type)) ||
      (field.custom !== undefined && typeof field.custom !== "boolean") ||
      field.required !== undefined
    )
      return result;
    keys.add(field.key);
    if (
      (field.title !== undefined && !limited(field.title, 4096)) ||
      (field.description !== undefined && !limited(field.description, 8192))
    )
      return result;
    const rawOptions = field.options ?? [];
    if (!Array.isArray(rawOptions) || rawOptions.length > 100) return result;
    const options: QuestionOption[] = [];
    const values = new Set<string>();
    for (const option of rawOptions) {
      if (
        !record(option) ||
        !limited(option.value, 4096) ||
        !option.value ||
        values.has(option.value) ||
        !limited(option.label, 4096) ||
        (option.description !== undefined && !limited(option.description, 8192))
      )
        return result;
      values.add(option.value);
      options.push({
        value: option.value,
        label: option.label,
        description:
          typeof option.description === "string" ? option.description : "",
      });
    }
    const custom = field.custom !== false;
    if (!custom && !options.length) return result;
    fields.push({
      key: field.key,
      kind:
        field.type === "multiselect"
          ? "multipleChoice"
          : options.length
            ? "singleChoice"
            : "text",
      title: typeof field.title === "string" ? field.title : "",
      prompt:
        typeof field.description === "string"
          ? field.description
          : typeof field.title === "string"
            ? field.title
            : "",
      options,
      custom,
    });
  }
  return assertContract("Question", {
    ...result,
    supported: true,
    reason: null,
    fields,
  });
}
export function validateQuestionAnswers(
  question: QuestionRequest,
  answers: QuestionAnswers,
) {
  if (Buffer.byteLength(JSON.stringify(answers)) > 32768)
    throw new PreflightError("ANSWER_TOO_LARGE", 413);
  if (
    Object.keys(answers).length !== question.fields.length ||
    Object.keys(answers).some(
      (key) => !question.fields.some((f) => f.key === key),
    )
  )
    throw new PreflightError("INVALID_REQUEST", 400);
  for (const field of question.fields) {
    const value = answers[field.key];
    const valid = (v: unknown): v is string =>
      typeof v === "string" &&
      v.trim().length > 0 &&
      (field.custom || field.options.some((o) => o.value === v));
    if (field.kind === "multipleChoice") {
      if (
        !Array.isArray(value) ||
        !value.length ||
        value.length > 101 ||
        new Set(value).size !== value.length ||
        !value.every(valid)
      )
        throw new PreflightError("INVALID_REQUEST", 400);
    } else if (!valid(value)) throw new PreflightError("INVALID_REQUEST", 400);
  }
}
