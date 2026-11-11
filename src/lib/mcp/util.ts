import { ToolError } from "@lovable.dev/mcp-js";

export function clip(value: string | null | undefined, max = 300): string | null {
  if (value == null) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function failIfError(error: { message: string } | null, what: string): void {
  if (error) throw new ToolError(`Could not read ${what}: ${error.message}`);
}
