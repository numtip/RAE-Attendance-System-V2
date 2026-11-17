import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { SsoError, SSO_ERROR_CODES } from './errors.js';

/**
 * Filesystem driver: a durable store on ONE host, with no service and no dependency.
 *
 * It exists because "durable" and "multi-host" are different requirements. A single host that must
 * survive a restart, or run two worker processes, does not need Redis: it needs a directory whose
 * create and consume operations are atomic at the syscall level.
 *
 * WHY THERE IS NO LOCK, NO REPLACE-IN-PLACE AND NO TOMBSTONE ANY MORE
 * ------------------------------------------------------------------
 * Three earlier shapes of "replace an expired single-use record" were shipped and each was
 * described as fixed. Each admitted TWO WINNERS for one record:
 *
 *   unlink + link                a claimer that had read the stale record deleted the winner's
 *                                fresh record and linked its own.
 *   rename + link                moving the record aside leaves the name ABSENT, so a third
 *                                claimer legitimately claims "an absent key" while the displaced
 *                                winner has already been told it won.
 *   link(2)-won lock, re-read,
 *   rename(temp, file)           the winner count was decided by rename(2), which has no winner
 *                                count: every holder of the lock that reached the rename "won".
 *                                It was correct only while the lock was never held twice — and the
 *                                lock's own stale takeover (rename the crashed holder's lock
 *                                aside) had exactly the absence gap that had just been fixed one
 *                                level down. With a crashed holder's lock planted, this shape
 *                                produced a double win in 1 of 60 rounds and 2 winners in one
 *                                round of an 8-worker test. The 0/135 measurement that closed it
 *                                never created that state.
 *
 * The lesson is not "use a better lock". Any scheme in which the claim path *removes a name* and
 * then re-creates it has an absence window, and a lock that must itself be recovered from a crash
 * only moves the window. So the claim path removes nothing:
 *
 *   A record lives in an IMMUTABLE GENERATION SLOT: `<slug>__<digest>.rec` (generation 0),
 *   `<slug>__<digest>.rec.1`, `.rec.2`, ... A slot is created by `link(2)` and never modified or
 *   removed by the claim path. An expired record is not replaced; the next claim creates the NEXT
 *   generation.
 *
 * WHY THAT MAKES EXACTLY ONE WINNER (the argument, not a measurement)
 * -------------------------------------------------------------------
 *   1. A claim reports success ONLY when this caller's own `link(2)` created a slot. `link` fails
 *      with EEXIST if the name exists, so at most one caller can create any given slot, ever.
 *   2. A claimant advances from generation g to g+1 only after *reading* slot g and finding its
 *      expiry in the past. A slot's body is immutable, so "expired" is a permanent property: a
 *      slot that was read expired can never become live again, and no later read can disagree.
 *   3. A claimant that cannot read a slot (ENOENT) does NOT advance. It retries a link at the same
 *      generation, so generations are never skipped.
 *   Therefore: each slot is written at most once; a claimant only writes at the first slot it has
 *   personally read as absent or expired; and a slot written by a winner is live, so the next
 *   claimant stops there and refuses. Two claimants cannot both win: two successes would need
 *   either two links on one name (impossible) or a live slot that a claimant skipped over
 *   (impossible, by 2 and 3).
 *
 * This is a structural argument, not a race measurement. It also removes the failure modes that
 * made the lock version fragile: there is no lease to expire, no lock to displace, no record to
 * rename aside, and a process killed at any point leaves either nothing or its own published claim
 * — never a blocked key.
 *
 * HOW EACH OPERATION IS OBTAINED
 * ------------------------------
 *   setIfAbsent  probe generations from 0. Link the record's temp file into the first absent slot,
 *                or into the next slot after the last expired one. A live slot refuses the claim.
 *   get          probe generations from 0 and return the first live one. At most one can be live.
 *   take         probe generations from 0, then `rename(2)` the live slot to a private name. rename
 *                succeeds for exactly one of any number of racers; every other caller gets ENOENT.
 *                That is a compare-and-delete, not a get-then-delete.
 *
 * CRASH AND STORAGE-ERROR BEHAVIOUR
 * ---------------------------------
 *   - A record's contents are fsynced before it is published, and the directory is fsynced after a
 *     slot is created or a consumed slot is removed. Without the directory fsync the NAME itself
 *     may be lost and a consumed code could come back after a power loss.
 *   - A crash leaves at most a private `.tmp-` file (never a claim, never a block) or the claim it
 *     had already published, which is the correct outcome because the caller was told it won.
 *   - A storage error (EACCES, ENOSPC/EFBIG, a removed root) is thrown to the caller. Nothing here
 *     converts a failed write into a successful claim, and `false` means "not this caller", never
 *     "probably fine".
 *   - A damaged record (truncated or hand-edited JSON) is treated as PRESENT by the claim path and
 *     refused: the store cannot prove the damaged body was not a live claim, and overwriting it
 *     would let a claim win over a record the store cannot account for. Damage does not block a
 *     future key, because keys are digests of distinct values.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 *   - It is not a multi-host store. Two hosts have two directories, and the two directories do not
 *     agree about anything. It is not a network-filesystem store either: `link(2)`/`rename(2)`
 *     atomicity over NFS/SMB is not the same as on a local POSIX filesystem, and NFS `rename` can
 *     be non-atomic across clients. That topology is UNVERIFIED and must be refused.
 *   - It does not expire records on its own. Every read compares the recorded `expiresAt` against
 *     the clock and treats an expired record as absent. There is no background sweeper, so a
 *     directory can hold dead slots that nothing reads. `count()` skips them. Expired generations
 *     are kept (removing one would re-open the absence window this design exists to close), so a
 *     key that is re-claimed after every TTL leaves one small file per window.
 *   - `count(prefix)` walks the directory and reads every record. That is O(n) per call, which is
 *     acceptable for the bounded deployment this driver is for and is NOT acceptable as a hot-path
 *     primitive. The store above it calls count only when it enforces a ceiling.
 *   - Nothing here is a backup policy. The directory holds session-id digests and the session
 *     records of THIS application; it must be backed up (or not) as part of this application,
 *     never by a host-wide job shared with another application.
 *
 * File permissions: the root is created 0700 (and tightened to 0700 if it already existed with
 * group/world access), and every record, temp and tombstone file is 0600. The digest is in the
 * file NAME and the record body carries only the stored value and its expiry; no plaintext binding,
 * code or session id is ever written.
 */

/**
 * How many generations one key may accumulate before the store refuses to add another.
 *
 * Each generation is one TTL window. A key only reaches generation 1 if it was claimed, expired,
 * and claimed again — for a digest of a one-time code that is a replay, and for a session id it
 * cannot happen. The bound exists so a probing loop is finite; reaching it refuses the claim, which
 * is the safe direction.
 */
const MAX_GENERATIONS = 16;

/** Filesystem-safe single segment. Colons are not portable, and keys contain them. */
function slug(text) {
  return String(text).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function prefixOf(key) {
  const cut = key.lastIndexOf(':');
  return cut === -1 ? '' : key.slice(0, cut);
}

/**
 * A slot may be `<digest>.rec` or `<digest>.rec.<generation>`. Both are records; a `.tmp-` file is
 * not, and neither is anything else the driver leaves behind.
 */
const RECORD_NAME = /\.rec(?:\.\d+)?$/;

/**
 * @param {string} root
 * @param {string} key
 * @param {number} generation
 */
function fileFor(root, key, generation = 0) {
  const base = join(root, `${slug(prefixOf(key))}__${digest(key)}.rec`);
  return generation === 0 ? base : `${base}.${generation}`;
}

/**
 * Read a record WITHOUT collapsing "absent" and "damaged" into one answer.
 *
 * `absent` (ENOENT) is a normal state. `ok` is a record. `malformed` is a file that exists and is
 * not a record this driver wrote — truncated, hand-edited, or written by something else. The claim
 * path must tell the difference: absence is claimable, damage is not.
 *
 * @param {string} file
 * @returns {{state: 'absent'} | {state: 'malformed'} | {state: 'ok', record: {v: string, e: number}}}
 */
function inspectRecord(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.v === 'string' &&
      Number.isFinite(parsed.e)
    ) {
      return { state: 'ok', record: { v: parsed.v, e: parsed.e } };
    }
  } catch {
    // Fall through: a truncated or hand-edited record is not a record.
  }
  return { state: 'malformed' };
}

/**
 * Make a directory entry durable.
 *
 * `fsync` on the record's descriptor flushes its contents; only a directory fsync makes the NAME
 * survive a power loss. Without this, a claim that was reported to the caller could be forgotten by
 * the filesystem and the same single-use record could be claimed again after a crash.
 *
 * @param {string} dir
 */
function fsyncDirectory(dir) {
  const handle = openSync(dir, 'r');
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

/**
 * @param {{
 *   root: string,
 *   ttlClock?: () => number,
 * }} options `ttlClock` replaces wall time so expiry can be tested without sleeping.
 */
export function createFileDriver({ root, ttlClock = () => Date.now() } = {}) {
  if (typeof root !== 'string' || root === '') {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: 'A file-backed store requires an explicit directory',
    });
  }
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: `The store directory is not usable: ${error.code ?? 'unknown error'}`,
    });
  }

  // The directory holds digests of session ids and codes. A pre-existing directory created 0755
  // would expose the set of digests to every local user, so group/world access is removed and the
  // result is verified rather than assumed. A directory whose mode cannot be tightened is refused.
  try {
    if ((statSync(root).mode & 0o077) !== 0) {
      chmodSync(root, 0o700);
    }
    if ((statSync(root).mode & 0o077) !== 0) {
      throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
        status: 500,
        message: 'The store directory is accessible to group or other users and could not be tightened',
      });
    }
  } catch (error) {
    if (error instanceof SsoError) throw error;
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: `The store directory permissions cannot be verified: ${error.code ?? 'unknown error'}`,
    });
  }

  function writeTemp(value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
        status: 500,
        message: 'A stored record needs a positive TTL in milliseconds',
      });
    }
    const temp = join(root, `.tmp-${randomUUID()}`);
    const body = JSON.stringify({ v: String(value), e: ttlClock() + ttlMs });
    const handle = openSync(temp, 'wx', 0o600);
    try {
      writeSync(handle, body, null, 'utf8');
      // The record must survive a crash after the caller was told it was stored: without the
      // fsync a claimed code could reappear as unused after a power loss, which is a replay.
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    return temp;
  }

  /**
   * Publish a fully-written temp file at `file`, exactly once.
   *
   * This is the ONLY function in this driver allowed to report a successful claim, and it reports
   * that only when the kernel accepted this caller's own link. `rename(2)` is deliberately not used
   * here: it has no winner count, so two claimers racing through it would both "win".
   *
   * @param {string} temp
   * @param {string} file
   * @returns {boolean} true when this call created the name
   */
  function publishByLink(temp, file) {
    try {
      linkSync(temp, file);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  }

  return {
    kind: 'file',

    /** @param {string} key @param {string} value @param {number} ttlMs */
    async setIfAbsent(key, value, ttlMs) {
      const temp = writeTemp(value, ttlMs);
      try {
        // Two iterations cover a slot that vanished between the link attempt and the read; more
        // than that means sustained contention, and a refused claim is the safe answer.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          let vanished = false;

          for (let generation = 0; generation < MAX_GENERATIONS; generation += 1) {
            const file = fileFor(root, key, generation);
            if (publishByLink(temp, file)) {
              fsyncDirectory(root);
              return true;
            }

            const slot = inspectRecord(file);
            if (slot.state === 'absent') {
              // The name existed a moment ago and is gone now. Do NOT advance: advancing on a
              // missing generation is the only way a claim could skip over a live slot.
              vanished = true;
              break;
            }
            if (slot.state === 'malformed') {
              // A damaged record is PRESENT, not free. It cannot be proven dead (the body that said
              // when it expired is unreadable), and overwriting it would let a claim win over a
              // record this store cannot account for. Refuse; an operator must look at the file.
              return false;
            }
            if (slot.record.e > ttlClock()) return false; // live: this key is already claimed

            // Expired: the slot is immutable and permanently dead, so the next generation is the
            // only place a new claim may be published.
          }

          if (!vanished) {
            // No absent or expired slot inside MAX_GENERATIONS: refuse rather than grow forever.
            return false;
          }
        }
        // Sustained contention without a decision. Refuse: a refused claim can never authenticate,
        // which is the direction a single-use store has to fail in.
        return false;
      } finally {
        try {
          unlinkSync(temp);
        } catch {
          // The temp file is private and uniquely named; leaving one behind on a crash is untidy,
          // never a correctness problem.
        }
      }
    },

    /** @param {string} key @returns {Promise<string|null>} */
    async get(key) {
      for (let generation = 0; generation < MAX_GENERATIONS; generation += 1) {
        const slot = inspectRecord(fileFor(root, key, generation));
        if (slot.state === 'absent') return null;
        if (slot.state === 'malformed') return null; // fail closed: no value from a damaged record
        if (slot.record.e > ttlClock()) return slot.record.v;
        // Expired: at most one slot per key is ever live, and it is the highest one written.
      }
      return null;
    },

    /**
     * Atomic single-use consume. Exactly one caller can win; the rest see null.
     * @param {string} key @returns {Promise<string|null>}
     */
    async take(key) {
      for (let generation = 0; generation < MAX_GENERATIONS; generation += 1) {
        const file = fileFor(root, key, generation);
        const slot = inspectRecord(file);
        if (slot.state === 'absent') return null;

        const claimed = join(root, `.take-${randomUUID()}`);
        if (slot.state === 'malformed') {
          // A damaged record is consumed rather than left to wedge the key forever, and it yields
          // no value: `take` must never turn damage into a successful read.
          try {
            renameSync(file, claimed);
          } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
          }
          fsyncDirectory(root);
          try {
            unlinkSync(claimed);
          } catch {
            // Private and uniquely named.
          }
          return null;
        }
        if (slot.record.e <= ttlClock()) continue; // dead slot: nothing to consume here

        try {
          renameSync(file, claimed);
        } catch (error) {
          if (error.code === 'ENOENT') return null; // another caller consumed it first
          throw error;
        }
        // The consume is the rename: make the absence durable before reporting it, or a crash could
        // resurrect a code that was already answered.
        fsyncDirectory(root);
        let record;
        try {
          record = inspectRecord(claimed);
        } finally {
          try {
            unlinkSync(claimed);
          } catch {
            // See above.
          }
        }
        if (record.state !== 'ok') return null;
        if (record.record.e <= ttlClock()) return null;
        return record.record.v;
      }
      return null;
    },

    /** @param {string} prefix @returns {Promise<number>} live records only */
    async count(prefix) {
      const wanted = slug(prefix.endsWith(':') ? `${prefix.slice(0, -1)}__` : prefix);
      let total = 0;
      for (const name of readdirSync(root)) {
        if (!RECORD_NAME.test(name)) continue;
        if (!name.startsWith(wanted)) continue;
        const slot = inspectRecord(join(root, name));
        if (slot.state === 'ok' && slot.record.e > ttlClock()) total += 1;
      }
      return total;
    },

    close() {
      // Nothing to close.
    },
  };
}
