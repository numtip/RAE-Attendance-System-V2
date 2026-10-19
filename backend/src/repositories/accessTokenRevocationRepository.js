const fs = require('node:fs/promises');
const path = require('node:path');

function assertRecord(record) {
  if (!record || typeof record.jti !== 'string' || record.jti.length === 0 || !record.expiresAt) {
    throw new Error('revocation record requires jti and expiresAt');
  }
}

function createMemoryAccessTokenRevocationRepository() {
  const tokens = new Map();
  return {
    async revoke(record) {
      assertRecord(record);
      tokens.set(record.jti, record.expiresAt);
    },
    async isRevoked(jti) {
      return tokens.has(jti);
    },
  };
}

function createFileAccessTokenRevocationRepository(filePath) {
  let chain = Promise.resolve();

  function exclusive(work) {
    const run = chain.then(work, work);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function readTokens() {
    let text;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !parsed.tokens || typeof parsed.tokens !== 'object') {
      throw new Error('revocation file is unreadable');
    }
    return parsed.tokens;
  }

  return {
    async revoke(record) {
      assertRecord(record);
      await exclusive(async () => {
        const tokens = await readTokens();
        tokens[record.jti] = record.expiresAt;
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ tokens }), 'utf8');
        await fs.rename(temporary, filePath);
      });
    },
    async isRevoked(jti) {
      const tokens = await readTokens();
      return Object.prototype.hasOwnProperty.call(tokens, jti);
    },
  };
}

module.exports = {
  createMemoryAccessTokenRevocationRepository,
  createFileAccessTokenRevocationRepository,
};
