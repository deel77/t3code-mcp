export class BridgeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
}

/** T3 decided against a command. Unlike a transport failure, nothing was applied. */
export class T3CommandRejected extends BridgeError {
  constructor(method, detail) {
    super(`T3 rejected ${method}: ${detail}`, 409);
    this.name = "T3CommandRejected";
    this.detail = detail;
  }
}
