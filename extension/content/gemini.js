globalThis.ChatContinuityRegisterExtractor("gemini", [
  {
    role: "user",
    selector:
      'main [data-message-author-role="user"], main [data-test-id="user-query"], main .user-query-bubble-with-background',
  },
  {
    role: "assistant",
    selector:
      'main [data-message-author-role="assistant"], main [data-test-id="model-response"], main .model-response-text',
  },
], {
  stableForMs: 180,
  maxWaitMs: 1200,
  pollIntervalMs: 75,
});
