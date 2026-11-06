// ../software-factory/server/software-factory-github-state.ts
import { createHash } from "node:crypto";

// ../software-factory/server/software-factory-encrypted-state.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
function createEncryptedFactoryTransport(options) {
  if (options.key.byteLength !== 32 || !options.scope.trim()) throw Error("FACTORY_STATE_ENCRYPTION_CONFIGURATION");
  const key = Buffer.from(options.key), aad = Buffer.from(`factory-state-v1:${options.scope}`);
  const limit = options.maxPlaintextBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 * 1024 * 1024) throw Error("FACTORY_STATE_ENCRYPTION_CONFIGURATION");
  const transport = options.transport;
  return {
    async read() {
      const value = await transport.read();
      if (!value) return void 0;
      try {
        if (Buffer.byteLength(value.body) > Math.ceil(limit * 4 / 3) + 256) throw Error();
        const envelope = JSON.parse(value.body);
        if (!envelope || Object.keys(envelope).sort().join() !== "ciphertext,nonce,tag,version" || envelope.version !== 1) throw Error();
        const decode = (text) => {
          if (typeof text !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw Error();
          return Buffer.from(text, "base64");
        };
        const nonce = decode(envelope.nonce), tag = decode(envelope.tag), ciphertext = decode(envelope.ciphertext);
        if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > limit) throw Error();
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        const bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        return { generation: value.generation, body };
      } catch {
        throw Error("FACTORY_STATE_AUTHENTICATION_FAILED");
      }
    },
    async compareAndSwap(expectedGeneration, body) {
      const bytes = Buffer.from(body);
      if (bytes.length > limit) throw Error("FACTORY_STATE_TOO_LARGE");
      if (bytes.toString("utf8") !== body) throw Error("FACTORY_STATE_INVALID_TEXT");
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const envelope = JSON.stringify({
        version: 1,
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64")
      });
      return transport.compareAndSwap(expectedGeneration, envelope);
    }
  };
}

// ../software-factory/server/software-factory-github-state.ts
function createGitHubFactoryStateTransport(options) {
  if (!/^[A-Za-z0-9-]+\/software-factory-pilot$/.test(options.repository)) throw Error("FACTORY_STATE_REPOSITORY_INVALID");
  const repository = options.repository, request = options.request;
  const limit = options.maxPlaintextBytes ?? 8 * 1024 * 1024;
  const encodedLimit = Math.ceil(limit * 4 / 3) + 256;
  const base = `https://api.github.com/repos/${repository}`;
  if (options.object !== void 0 && !["ledger", "transport-probe"].includes(options.object)) throw Error("FACTORY_STATE_OBJECT_INVALID");
  const path = `.factory/${options.object ?? "ledger"}.enc.json`, branch = "factory-state";
  const shaValid = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
  const blobSha = (body) => createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
  const generation = (sha) => BigInt(`0x${sha}`).toString();
  const decodeGeneration = (value) => {
    if (!/^[1-9][0-9]{0,48}$/.test(value)) throw Error("FACTORY_STATE_GENERATION_INVALID");
    const sha = BigInt(value).toString(16).padStart(40, "0");
    if (!shaValid(sha)) throw Error("FACTORY_STATE_GENERATION_INVALID");
    return sha;
  };
  async function call(route, method = "GET", body) {
    try {
      const response = await request(base + route, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15e3),
        headers: { Accept: method === "GET" && route.startsWith("/contents/") ? "application/vnd.github.object+json" : "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
        ...body === void 0 ? {} : { body: JSON.stringify(body) }
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, data: void 0 };
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error();
      const chunks = [];
      let size = 0;
      try {
        for (; ; ) {
          const c = await reader.read();
          if (c.done) break;
          size += c.value.length;
          if (size > Math.ceil(encodedLimit * 4 / 3) + 65536) throw Error();
          chunks.push(Buffer.from(c.value));
        }
      } finally {
        await reader.cancel();
      }
      return { status: response.status, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch {
      throw Error("FACTORY_STATE_REQUEST_UNCONFIRMED");
    }
  }
  async function validateRepository() {
    const r = await call("");
    if (r.status !== 200 || r.data?.full_name !== repository || r.data.private !== false || r.data.archived || r.data.disabled || r.data.default_branch === branch) throw Error("FACTORY_STATE_REPOSITORY_UNVERIFIED");
  }
  const raw = {
    async read() {
      await validateRepository();
      const meta = await call(`/contents/${path}?ref=refs%2Fheads%2F${branch}`);
      if (meta.status === 404) return void 0;
      const m = meta.data;
      if (meta.status !== 200 || m?.type !== "file" || m.path !== path || !shaValid(m.sha) || !Number.isSafeInteger(m.size) || m.size < 0 || m.size > encodedLimit) throw Error("FACTORY_STATE_METADATA_INVALID");
      const blob = await call(`/git/blobs/${m.sha}`), b = blob.data;
      if (blob.status !== 200 || b?.sha !== m.sha || b.encoding !== "base64" || b.size !== m.size || typeof b.content !== "string") throw Error("FACTORY_STATE_VERSION_UNCONFIRMED");
      const encoded = b.content.replace(/\n/g, "");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded || bytes.length !== m.size || blobSha(bytes) !== m.sha) throw Error("FACTORY_STATE_VERSION_UNCONFIRMED");
      return { generation: generation(m.sha), body: new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes) };
    },
    async compareAndSwap(expected, body) {
      const sha = expected === null ? void 0 : decodeGeneration(expected);
      if (Buffer.byteLength(body) > encodedLimit) throw Error("FACTORY_STATE_TOO_LARGE");
      await validateRepository();
      const bytes = Buffer.from(body);
      const r = await call(`/contents/${path}`, "PUT", {
        branch,
        message: "Checkpoint encrypted factory state",
        content: bytes.toString("base64"),
        ...sha ? { sha } : {}
      });
      if (r.status === 409) return { kind: "conflict" };
      if (![200, 201].includes(r.status) || r.data?.content?.sha !== blobSha(bytes) || r.data.content.path !== path) throw Error("FACTORY_STATE_WRITE_UNCONFIRMED");
      return { kind: "written", generation: generation(r.data.content.sha) };
    }
  };
  return createEncryptedFactoryTransport({ transport: raw, key: options.key, scope: `${repository}/${branch}/${path}`, maxPlaintextBytes: limit });
}
export {
  createGitHubFactoryStateTransport
};
