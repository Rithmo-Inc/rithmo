// The model contract, and the one client that needs no provider.
//
// THE CONTRACT ONLY, DELIBERATELY. Everything an employee needs in order to TALK to a model is four
// declarations: a request, a reply, the interface, and a scripted stand-in for tests. Everything
// needed to REACH a vendor -- an HTTP client, an API key, per-vendor pricing, spend limiting,
// environment reads, a factory -- is a separate concern, and none of it is in this repository.
//
// That separation is why Core is liftable: `src/employees/runtime.ts` imports only `ModelClient`,
// and every test here uses only `ScriptedModelClient`. Nothing in this tree opens a socket or reads
// a credential, so nothing has to be trusted not to.
//
// BRING YOUR OWN CLIENT. To drive employees with a real model, implement `ModelClient` against
// whichever provider you use and pass it in. The environment does not care which, and does not need
// to know.
//
// THIS FILE IMPORTS NOTHING. Not even a logger: a scripted client has nothing to report. That is
// what makes it liftable, and the Core boundary test asserts it.

export interface ModelRequest {
  system: string;
  user: string;
}

export interface ModelReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export interface ModelClient {
  complete(req: ModelRequest): Promise<ModelReply>;
  spentUsd(): number;
}

// Used by fixtures and offline tests. A scripted client is clearly labelled as such and
// never presented as autonomous behaviour.
export class ScriptedModelClient implements ModelClient {
  readonly #replies: string[];
  #i = 0;

  constructor(replies: string[]) {
    this.#replies = replies;
  }

  spentUsd(): number {
    return 0;
  }

  async complete(): Promise<ModelReply> {
    if (this.#i >= this.#replies.length) throw new Error("scripted replies exhausted");
    return {
      text: this.#replies[this.#i++],
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd: 0,
    };
  }
}
