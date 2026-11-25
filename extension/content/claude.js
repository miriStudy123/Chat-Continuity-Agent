globalThis.ChatContinuityRegisterExtractor("claude", [
  {
    role: "user",
    selector: 'main [data-testid="user-message"]',
  },
  {
    role: "assistant",
    selector:
      'main [data-testid="assistant-message"], main .font-claude-response',
  },
]);
