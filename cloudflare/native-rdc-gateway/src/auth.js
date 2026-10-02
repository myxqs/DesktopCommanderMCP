const DEVICE_ORIGIN_KEY = 'native-rdc:m2:trusted-device-origin-sha256';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => '&#' + char.charCodeAt(0) + ';');
}

async function hashText(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requestOriginDigest(request) {
  const source = request.headers.get('cf-connecting-ip');
  return source ? hashText(source) : null;
}

async function trustedAuthorizationOrigin(request, env) {
  if (!env.OAUTH_KV) return false;
  const [actual, expected] = await Promise.all([
    requestOriginDigest(request),
    env.OAUTH_KV.get(DEVICE_ORIGIN_KEY),
  ]);
  return Boolean(actual && expected && actual === expected);
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
    + '<p>This M2 proof only authorizes from the network currently hosting the authenticated trusted Windows device.</p>'
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

async function handleAuthorize(request, env) {
  if (!await trustedAuthorizationOrigin(request, env)) {
    return html(
      '<!doctype html><meta charset="utf-8"><h1>Authorization unavailable</h1><p>Authorization must be initiated from the network currently hosting the trusted Windows device.</p>',
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
        userId: 'native-rdc-owner',
        metadata: { profile: 'native-rdc-owner', proof: 'trusted-device-network-origin' },
        scope: approved.request.scope,
        props: { userId: 'native-rdc-owner' },
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

async function recordTrustedDeviceOrigin(request, env, response) {
  if (response.status !== 101 || !env.OAUTH_KV) return;
  const digest = await requestOriginDigest(request);
  if (!digest) return;
  await env.OAUTH_KV.put(DEVICE_ORIGIN_KEY, digest, { expirationTtl: 86400 });
}

export function createDefaultHandler(fallbackFetch) {
  if (typeof fallbackFetch !== 'function') throw new TypeError('fallbackFetch is required');
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/authorize') return handleAuthorize(request, env);

      const response = await fallbackFetch(request, env);
      if (url.pathname === '/v1/device/connect') {
        await recordTrustedDeviceOrigin(request, env, response);
      }
      return response;
    },
  };
}

export {
  DEVICE_ORIGIN_KEY,
  handleAuthorize,
  requestOriginDigest,
  trustedAuthorizationOrigin,
};