const { PROVIDER_MJU_SSO } = require('../domain/identityLink');

function createFixtureIdentityLinkRepository() {
  let nextId = 1;
  const providers = [
    {
      id: 1,
      providerKey: PROVIDER_MJU_SSO,
      name: 'MJU SSO',
      status: 'active',
    },
  ];
  /** @type {import('./identityLinkRepository').EmployeeIdentityLinkRow[]} */
  const links = [];

  function mapLink(row) {
    const provider = providers.find((item) => item.id === row.providerId);
    return {
      ...row,
      providerKey: provider ? provider.providerKey : '',
    };
  }

  return {
    async findProviderByKey(providerKey) {
      return providers.find((row) => row.providerKey === providerKey) || null;
    },

    async insertLink(input) {
      const row = {
        id: nextId++,
        employeeUid: input.employeeUid,
        providerId: input.providerId,
        providerSubject: input.providerSubject,
        subjectType: input.subjectType || 'opaque',
        emailSnapshot: input.emailSnapshot ?? null,
        personnelIdSnapshot: input.personnelIdSnapshot ?? null,
        citizenIdHash: input.citizenIdHash ?? null,
        status: input.status || 'candidate',
        confidence: input.confidence || 'unknown',
        source: input.source,
        enrichmentOutcome: input.enrichmentOutcome ?? null,
        approvedBy: input.approvedBy ?? null,
        approvedAt: input.approvedAt ?? null,
        createdAt: input.createdAt || new Date().toISOString(),
        updatedAt: input.updatedAt || new Date().toISOString(),
      };
      links.push(row);
      return mapLink(row);
    },

    async findByProviderSubject(providerKey, providerSubject) {
      const provider = providers.find((row) => row.providerKey === providerKey);
      if (!provider) return null;
      const row = links.find(
        (item) => item.providerId === provider.id && item.providerSubject === providerSubject,
      );
      return row ? mapLink(row) : null;
    },

    async findById(id) {
      const row = links.find((item) => item.id === id);
      return row ? mapLink(row) : null;
    },

    async findApprovedForEmployee(employeeUid, providerId) {
      const row = links.find(
        (item) => item.employeeUid === employeeUid
          && item.providerId === providerId
          && item.status === 'approved',
      );
      return row ? mapLink(row) : null;
    },

    async updateLink(id, patch) {
      const row = links.find((item) => item.id === id);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return mapLink(row);
    },
  };
}

module.exports = { createFixtureIdentityLinkRepository };
