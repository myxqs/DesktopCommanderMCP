function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => '&#' + char.charCodeAt(0) + ';');
}

function securityHeaders(headers = new Headers()) {
  headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('cache-control', 'no-store');
  return headers;
}

function consentPage(details, handle) {
  const name = escapeHtml(details.clientName || 'MCP client');
  const origin = details.clientDomain
    ? 'Published by <strong>' + escapeHtml(details.clientDomain) + '</strong>.'
    : 'This client is dynamically registered; verify the redirect destination before continuing.';
  const scopes = details.scope.map((scope) => (
    '<label><input type="checkbox" name="scope" value="' + escapeHtml(scope)
    + '" checked> ' + escapeHtml(scope) + '</label>'
  )).join('<br>');
  const warning = details.redirectIsLoopback
    ? '<p><strong>The redirect returns access to an application on this computer.</strong></p>'
    : '';

  return '<!doctype html><meta charset="utf-8"><title>Authorize ' + name + '</title>'
    + '<style>body{font-family:system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem;line-height:1.5}button{padding:.6rem 1rem;margin-right:.5rem}</style>'
    + '<h1>Authorize ' + name + '</h1>'
    + '<p>' + origin + ' Access will return to <strong>' + escapeHtml(details.redirectHost) + '</strong>.</p>'
    + warning
    + '<p>Authorization is restricted to the configured Native RDC owner through Cloudflare Access.</p>'
    + '<form method="post">'
    + '<input type="hidden" name="handle" value="' + escapeHtml(handle) + '">'
    + '<p>' + scopes + '</p>'
    + '<p><button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></p>'
    + '</form>';
}

function html(body, status = 200, headers = new Headers()) {
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(body, { status, headers: securityHeaders(headers) });
}

function normalizedOwner(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

async function trustedAuthorizationOwner(env, ctx) {
  const expected = normalizedOwner(env.OWNER_EMAIL);
  if (!expected || !ctx?.access || typeof ctx.access.getIdentity !== 'function') return null;
  let identity;
  try {
    identity = await ctx.access.getIdentity();
  } catch {
    return null;
  }
  const email = normalizedOwner(identity?.email);
  if (!email || email !== expected) return null;
  return { userId: 'cloudflare-access:' + email, email };
}

async function handleAuthorize(request, env, ctx) {
  const owner = await trustedAuthorizationOwner(env, ctx);
  if (!owner) {
    return html(
      '<!doctype html><meta charset="utf-8"><h1>Authorization unavailable</h1><p>Cloudflare Access owner authentication is required.</p>',
      403,
    );
  }

  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return new Response('Authorization service unavailable', { status: 503 });

  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return html(consentPage(details, consent.handle), 200, consent.headers);
    }
    if (request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') || '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }

      const approved = await oauth.approveConsent(request, handle, {
        scope: form.getAll('scope').map(String),
      });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: owner.userId,
        metadata: {
          profile: 'native-rdc-owner',
          proof: 'cloudflare-access',
          owner: owner.userId,
        },
        scope: approved.request.scope,
        props: { userId: owner.userId },
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }

    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'GET, POST' },
    });
  } catch (error) {
    if (typeof error?.redirectTo === 'string') return Response.redirect(error.redirectTo, 302);
    return html('<!doctype html><meta charset="utf-8"><h1>Authorization request rejected</h1><p>The request could not be safely authorized.</p>', 400);
  }
}

export function createDefaultHandler(fallbackFetch) {
  if (typeof fallbackFetch !== 'function') throw new TypeError('fallbackFetch is required');
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === '/authorize') return handleAuthorize(request, env, ctx);
      return fallbackFetch(request, env, ctx);
    },
  };
}

export {
  handleAuthorize,
  trustedAuthorizationOwner,
};
