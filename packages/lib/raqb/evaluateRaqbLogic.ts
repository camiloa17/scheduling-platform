"use client";

export const enum RaqbLogicResult {
  MATCH = "MATCH",
  NO_MATCH = "NO_MATCH",
  LOGIC_NOT_FOUND_SO_MATCHED = "LOGIC_NOT_FOUND_SO_MATCHED",
}

type EvaluateInput = {
  queryValue: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryBuilderConfig: any;
  data: Record<string, unknown>;
  beStrictWithEmptyLogic?: boolean;
  },
  config: {
    // 2 - Error/Warning
    // 1 - Info
    // 0 - Debug
  logLevel: 0 | 1 | 2;
};

const warnOnce = (() => {
  let warned = false;
  return (message: string) => {
    if (!warned) {
      warned = true;
      console.warn(message);
    }
  };
})();

export const evaluateRaqbLogic = (
  _input: EvaluateInput,
  _config: EvaluateConfig = {
    logLevel: 1,
  }
): RaqbLogicResult => {
  warnOnce(
    "evaluateRaqbLogic: React Awesome Query Builder evaluation is disabled. Falling back to default match behaviour."
  );
  return RaqbLogicResult.LOGIC_NOT_FOUND_SO_MATCHED;
};
