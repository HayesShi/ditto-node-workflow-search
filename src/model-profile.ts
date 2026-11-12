/** Stable benchmark generation; declarative optimizer output has its own host bound. */
export const OPTIMIZER_MAX_OUTPUT_TOKENS=16384;
export const EXPERIMENT_GENERATION = Object.freeze({ temperature: 0, maxTokens: 393_216 });
export const EXPERIMENT_PROVIDER_OPTIONS = Object.freeze({
  thinking: Object.freeze({ type: "disabled" }),
  n: 1,
  response_format: Object.freeze({ type: "text" }),
});
export const EXPERIMENT_EXECUTION = Object.freeze({
  maxSteps: Number.MAX_SAFE_INTEGER,
  maxIterations: Number.MAX_SAFE_INTEGER,
});

/** Profiles select environment capabilities, never different generation settings. */
export type ExperimentModelProfile = "math" | "automationbench";
