export interface ToolValidationError {
  code: "missing_schema" | "malformed_schema" | "invalid_arguments";
  message: string;
  path?: string;
}

export type ToolValidationResult =
  | { ok: true }
  | { ok: false; error: ToolValidationError };

export function validateToolArguments(schema: unknown, value: unknown): ToolValidationResult {
  if (!isSchemaObject(schema)) return { ok: false, error: { code: "missing_schema", message: "Tool input schema is missing or malformed" } };
  return validateValue(schema, value, "$", true);
}

function validateValue(schema: Record<string, unknown>, value: unknown, path: string, root = false): ToolValidationResult {
  const type = schema.type;
  if (type === undefined && root) return invalid(path, "Tool input schema must declare an object type");
  if (type === "object") {
    if (!isRecord(value)) return invalid(path, "Expected an object");
    const properties = schema.properties;
    if (properties !== undefined && !isRecord(properties)) return malformed("Tool object properties are malformed");
    const required = schema.required;
    if (required !== undefined && (!Array.isArray(required) || required.some((item) => typeof item !== "string"))) {
      return malformed("Tool required fields are malformed");
    }
    for (const key of (required as string[] | undefined) ?? []) {
      if (!(key in value)) return invalid(`${path}.${key}`, "Required argument is missing");
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!properties || !(key in properties)) return invalid(`${path}.${key}`, "Unexpected argument");
      }
    }
    for (const [key, propertySchema] of Object.entries(properties ?? {})) {
      if (key in value) {
        if (!isRecord(propertySchema)) return malformed(`${path}.${key} schema is malformed`);
        const result = validateValue(propertySchema, value[key], `${path}.${key}`);
        if (!result.ok) return result;
      }
    }
    return { ok: true };
  }
  if (type === "array") {
    if (!Array.isArray(value)) return invalid(path, "Expected an array");
    if (!isRecord(schema.items)) return malformed("Array item schema is malformed");
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return invalid(path, "Array has too few items");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return invalid(path, "Array has too many items");
    for (let index = 0; index < value.length; index++) {
      const result = validateValue(schema.items, value[index], `${path}[${index}]`);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (type === "string") {
    if (typeof value !== "string") return invalid(path, "Expected a string");
    if (Array.isArray(schema.enum) && (!schema.enum.includes(value))) return invalid(path, "Value is not in the allowed enum");
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return invalid(path, "String is too short");
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return invalid(path, "String is too long");
    return { ok: true };
  }
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return invalid(path, "Expected a finite number");
    if (typeof schema.minimum === "number" && value < schema.minimum) return invalid(path, "Number is below the minimum");
    if (typeof schema.maximum === "number" && value > schema.maximum) return invalid(path, "Number exceeds the maximum");
    return { ok: true };
  }
  if (type === "boolean") return typeof value === "boolean" ? { ok: true } : invalid(path, "Expected a boolean");
  return malformed(`${path} has an unsupported schema type`);
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "object";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(path: string, message: string): ToolValidationResult { return { ok: false, error: { code: "invalid_arguments", message, path } }; }
function malformed(message: string): ToolValidationResult { return { ok: false, error: { code: "malformed_schema", message } }; }
