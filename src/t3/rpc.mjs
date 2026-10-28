import { readFile } from "node:fs/promises";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { BridgeError, T3CommandRejected } from "../errors.mjs";

const group = RpcGroup.make(
  Rpc.make("server.getConfig", { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make("orchestration.dispatchCommand", { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make("orchestration.launchThread", { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make("orchestration.getArchivedShellSnapshot", { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make("orchestration.searchThreads", { payload: Schema.Struct({ query: Schema.String, limit: Schema.optional(Schema.Number) }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make("orchestration.getTurnDiff", { payload: Schema.Struct({ threadId: Schema.String, fromTurnCount: Schema.Number, toTurnCount: Schema.Number, ignoreWhitespace: Schema.optional(Schema.Boolean) }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make("orchestration.subscribeThread", { payload: Schema.Struct({ threadId: Schema.String, afterSequence: Schema.Number, requestCompletionMarker: Schema.Boolean, turnLimit: Schema.optional(Schema.Number) }), success: Schema.Unknown, error: Schema.Unknown, stream: true }),
);
const makeClient = RpcClient.make(group);

// T3 returns its user-facing reason in a tagged dispatch error. Pass on only
// that bounded text; transport, timeout and other failures stay generic.
export function rejectionDetail(error) {
  if (!error || typeof error !== "object" || !/DispatchCommandError$/.test(String(error._tag))) return null;
  const text = [error.detail, error.message].find((value) => typeof value === "string" && value.trim());
  return text ? text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) : null;
}

export async function callT3Rpc({ baseUrl, tokenFile, fetchImpl = fetch }, method, input, options = {}) {
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token || token.includes("\n")) throw new BridgeError("T3 credential file is invalid.", 500);
  const ticketResponse = await fetchImpl(new URL("/api/auth/websocket-ticket", baseUrl), {
    method: "POST", headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  if (!ticketResponse.ok) throw new BridgeError(`T3 WebSocket ticket failed: HTTP ${ticketResponse.status}.`, 502);
  const { ticket } = await ticketResponse.json();
  if (typeof ticket !== "string" || !ticket) throw new BridgeError("T3 WebSocket ticket is invalid.", 502);
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url.href, { openTimeout: "10 seconds" }).pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    )),
    Layer.provide(RpcSerialization.layerJson),
  );
  const operation = Effect.gen(function* () {
    const client = yield* makeClient;
    if (options.untilSynchronized) {
      return yield* client[method](input).pipe(
        Stream.takeUntil((item) => item?.kind === "synchronized"),
        Stream.runCollect,
        Effect.map((items) => [...items]),
      );
    }
    return yield* client[method](input);
  }).pipe(Effect.provide(protocol), Effect.scoped, Effect.timeout("15 seconds"));
  let exit;
  try {
    exit = await Effect.runPromiseExit(operation);
  } catch {
    exit = null;
  }
  if (exit && Exit.isSuccess(exit)) return exit.value;
  const detail = exit ? rejectionDetail(Option.getOrUndefined(Cause.findErrorOption(exit.cause))) : null;
  if (detail) throw new T3CommandRejected(method, detail);
  throw new BridgeError(`T3 RPC ${method} failed. Check the T3Code service and retry.`, 502);
}
