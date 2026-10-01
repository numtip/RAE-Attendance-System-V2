function buildCidUrl(baseUrl, clientId) {
  const url = new URL(baseUrl);
  url.searchParams.set('cid', clientId);
  return url.toString();
}

module.exports = { buildCidUrl };
