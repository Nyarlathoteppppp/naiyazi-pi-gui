import { expect, test } from "@playwright/test";
import { modelMatchesEnabledPatterns } from "../../src/model-settings";

test("matches Pi enabled-model globs and exact model references", () => {
  expect(modelMatchesEnabledPatterns("litellm-local", "or-gpt-5.6-luna", ["litellm-local/*"])).toBe(true);
  expect(modelMatchesEnabledPatterns("litellm-local", "or-deepseek-v4-flash-latest", ["litellm-local/*"])).toBe(true);
  expect(modelMatchesEnabledPatterns("openai-codex", "gpt-5.6-luna", ["openai-codex/gpt-5.6-*"])).toBe(true);
  expect(modelMatchesEnabledPatterns("openai-codex", "gpt-6-astra", ["openai-codex/gpt-5.6-*"])).toBe(false);
  expect(modelMatchesEnabledPatterns("openai-codex", "gpt-6-astra", ["openai-codex/gpt-6-astra"])).toBe(true);
});

test("matches bare model patterns case-insensitively and treats an empty scope as all models", () => {
  expect(modelMatchesEnabledPatterns("litellm-local", "OR-GPT-5.6-LUNA", ["or-gpt-5.6-*"])).toBe(true);
  expect(modelMatchesEnabledPatterns("litellm-local", "or-gpt-5.6-luna", [])).toBe(true);
});
