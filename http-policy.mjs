// This is an authority check, not a TLS terminator or a proxy trust policy.
export function allowedHosts(env) {
  const values = env.Z2M_HTTP_ALLOWED_HOSTS?.split(',');
  if (!values?.length || values.length > 16) throw new Error('Explicit HTTP allowed hosts are required');
  return new Set(values.map((value) => {
    const authority = value.trim().toLowerCase();
    let url;
    try { url = new URL(`http://${authority}`); } catch { throw new Error('Invalid HTTP allowed host'); }
    if (!authority || url.host !== authority || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || authority.includes('*')) {
      throw new Error('Invalid HTTP allowed host');
    }
    return authority;
  }));
}

export function createHttpPolicy(env = process.env) {
  const hosts = allowedHosts(env);
  return (req, res, next) => {
    const names = req.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
    // This package deliberately supports non-browser MCP clients only. Reject
    // Origin even for authenticated requests; CORS alone is not an access check.
    if (names.includes('origin') || names.filter((name) => name === 'host').length !== 1 ||
        typeof req.headers.host !== 'string' || !hosts.has(req.headers.host.toLowerCase())) {
      res.status(403).send('HTTP authority or origin refused');
      return;
    }
    next();
  };
}
