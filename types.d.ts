// Augment Express Request to include the `agent` property set by agentProtect middleware
declare namespace Express {
  interface Request {
    agent?: any;
  }
}
