import { connect } from 'node:net';

/**
 * A minimal RESP2 client: enough to run the handful of commands a store needs, with no dependency.
 *
 * Why hand-rolled: the repository has zero runtime dependencies by policy (`package.json` has no
 * `dependencies`), and adding a Redis client would be an owner decision. The protocol is small:
 * a command is a bulk-string array, and every reply this client sends can produce is a status, an
 * error, an integer, a bulk string or a nil. Arrays are parsed so a future command cannot silently
 * desynchronise the stream.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 *   - No TLS (`tls:` is not implemented). A store across a network must be reached over a private
 *     link; the intended deployment is a loopback TCP port or a unix socket on the same host.
 *   - No reconnection loop it can hide in. A broken connection rejects every in-flight command and
 *     the next command attempts ONE fresh connect. An unreachable store therefore surfaces as a
 *     rejected promise — which is what the store above turns into a refusal — rather than as a
 *     retry that eventually succeeds or hangs.
 *   - No pipelining API, no pub/sub, no cluster, no sentinel.
 *
 * Every command has a deadline (`commandTimeoutMs`). A timeout destroys the socket: a reply that
 * arrives after the caller was failed must never be handed to a later command.
 */

/**
 * @param {Buffer} buffer
 * @returns {{value?: unknown, error?: Error, next: number}|null} null when more bytes are needed
 */
function parseReply(buffer) {
  if (buffer.length === 0) return null;
  const endOfLine = buffer.indexOf('\r\n');
  if (endOfLine < 0) return null;

  const type = String.fromCharCode(buffer[0]);
  const line = buffer.subarray(1, endOfLine).toString('utf8');

  if (type === '+') return { value: line, next: endOfLine + 2 };
  if (type === '-') {
    const error = new Error(line);
    error.redis = true;
    return { error, next: endOfLine + 2 };
  }
  if (type === ':') return { value: Number(line), next: endOfLine + 2 };

  if (type === '$') {
    const length = Number(line);
    if (!Number.isInteger(length) || length < -1) {
      return { error: new Error('redis: malformed bulk length'), next: endOfLine + 2 };
    }
    if (length === -1) return { value: null, next: endOfLine + 2 };
    const start = endOfLine + 2;
    if (buffer.length < start + length + 2) return null;
    return { value: buffer.subarray(start, start + length).toString('utf8'), next: start + length + 2 };
  }

  if (type === '*') {
    const count = Number(line);
    if (!Number.isInteger(count) || count < -1) {
      return { error: new Error('redis: malformed array length'), next: endOfLine + 2 };
    }
    if (count === -1) return { value: null, next: endOfLine + 2 };
    const values = [];
    let cursor = endOfLine + 2;
    for (let index = 0; index < count; index += 1) {
      const nested = parseReply(buffer.subarray(cursor));
      if (!nested) return null;
      if (nested.error) return { error: nested.error, next: cursor + nested.next };
      values.push(nested.value);
      cursor += nested.next;
    }
    return { value: values, next: cursor };
  }

  // Unknown type: consume the line so the stream cannot stall on it forever.
  return { error: new Error('redis: unexpected reply type'), next: endOfLine + 2 };
}

/** @param {readonly unknown[]} args */
function encodeCommand(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`, 'latin1')];
  for (const arg of args) {
    const body = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), 'utf8');
    parts.push(Buffer.from(`$${body.length}\r\n`, 'latin1'), body, Buffer.from('\r\n', 'latin1'));
  }
  return Buffer.concat(parts);
}

/**
 * @param {{
 *   socketPath?: string,
 *   host?: string,
 *   port?: number,
 *   password?: string,
 *   username?: string,
 *   db?: number,
 *   connectTimeoutMs?: number,
 *   commandTimeoutMs?: number,
 * }} [options]
 */
export function createRedisClient({
  socketPath,
  host = '127.0.0.1',
  port = 6379,
  password,
  username,
  db = 0,
  connectTimeoutMs = 2000,
  commandTimeoutMs = 2000,
} = {}) {
  /** @type {import('node:net').Socket|null} */
  let socket = null;
  let ready = false;
  let closed = false;
  /** @type {Promise<void>|null} */
  let connecting = null;
  /** @type {Array<{resolve: (value: unknown) => void, reject: (error: Error) => void, timer: NodeJS.Timeout}>} */
  const pending = [];
  let buffer = Buffer.alloc(0);

  function failAll(error) {
    while (pending.length > 0) {
      const waiter = pending.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  function detach(error) {
    ready = false;
    const gone = socket;
    socket = null;
    buffer = Buffer.alloc(0);
    if (gone) {
      gone.removeAllListeners();
      gone.destroy();
    }
    failAll(error);
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const parsed = parseReply(buffer);
      if (!parsed) return;
      buffer = buffer.subarray(parsed.next);
      const waiter = pending.shift();
      if (!waiter) continue; // A reply nobody is waiting for: the caller already timed out.
      clearTimeout(waiter.timer);
      if (parsed.error) waiter.reject(parsed.error);
      else waiter.resolve(parsed.value);
    }
  }

  function openSocket() {
    return new Promise((resolve, reject) => {
      const attempt = socketPath ? connect(socketPath) : connect({ host, port });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        attempt.destroy();
        reject(new Error('redis: connect timeout'));
      }, connectTimeoutMs);

      attempt.setNoDelay?.(true);
      attempt.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket = attempt;
        ready = true;
        attempt.on('data', onData);
        attempt.on('error', (error) => detach(error));
        attempt.on('close', () => detach(new Error('redis: connection closed')));
        resolve();
      });
      attempt.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        attempt.destroy();
        reject(error);
      });
    });
  }

  async function ensureConnected() {
    if (closed) throw new Error('redis: client is closed');
    if (ready && socket) return;
    if (!connecting) {
      connecting = openSocket()
        .then(async () => {
          if (password) await rawCommand(username ? ['AUTH', username, password] : ['AUTH', password]);
          if (db !== 0) {
            const selected = await rawCommand(['SELECT', db]);
            if (selected !== 'OK') throw new Error('redis: SELECT failed');
          }
        })
        .catch((error) => {
          // A half-open connection that failed AUTH/SELECT must not be treated as usable: the next
          // command would be sent unauthenticated to the wrong database.
          detach(error);
          throw error;
        })
        .finally(() => {
          connecting = null;
        });
    }
    await connecting;
  }

  /** @param {readonly unknown[]} args */
  function rawCommand(args) {
    return new Promise((resolve, reject) => {
      if (!socket || !ready) {
        reject(new Error('redis: not connected'));
        return;
      }
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          // The reply may still arrive; the socket is destroyed so it cannot be mistaken for the
          // answer to whatever command is issued next.
          detach(new Error('redis: command timeout'));
        }, commandTimeoutMs),
      };
      pending.push(waiter);
      try {
        socket.write(encodeCommand(args));
      } catch (error) {
        pending.pop();
        clearTimeout(waiter.timer);
        reject(error);
      }
    });
  }

  return {
    /** @param {...unknown} args */
    async command(...args) {
      if (args.length === 0) throw new Error('redis: a command needs at least one argument');
      await ensureConnected();
      return rawCommand(args);
    },
    close() {
      closed = true;
      detach(new Error('redis: client is closed'));
    },
    get isOpen() {
      return ready && !closed;
    },
  };
}
