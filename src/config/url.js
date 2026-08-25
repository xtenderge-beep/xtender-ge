function getBaseUrl() {
  return process.env.DOMAIN ? `https://${process.env.DOMAIN}` : 'http://localhost:3000';
}

module.exports = { getBaseUrl };
