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

function connectionOwner(env) {
  const id = env.CONNECTION_OWNER.idFromName('primary');
  return env.CONNECTION_OWNER.get(id);
}

function approvalPage(record) {
  const target = escapeHtml(record?.arguments?.path || 'unknown target');
  const id = escapeHtml(record.id);
  const fingerprint = escapeHtml(record.fingerprint);
  return '<!doctype html><meta charset="utf-8"><title>Native RDC approval</title>'
    + '<style>body{font-family:system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem;line-height:1.5}code{word-break:break-all}button{padding:.6rem 1rem;margin-right:.5rem}</style>'
    + '<h1>Approve Native RDC action</h1>'
    + '<p><strong>Action:</strong> create directory</p><p><strong>Target:</strong> <code>' + target + '</code></p>'
    + '<p>This approval is single-use and expires automatically.</p>'
    + '<form method="post"><input type="hidden" name="id" value="' + id + '">'
    + '<input type="hidden" name="fingerprint" value="' + fingerprint + '">'
    + '<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>';
}

async function handleApproval(request, env, ctx, id) {
  const owner = await trustedAuthorizationOwner(env, ctx);
  if (!owner) return html('<!doctype html><meta charset="utf-8"><h1>Approval unavailable</h1><p>Cloudflare Access owner authentication is required.</p>', 403);
  const stub = connectionOwner(env);
  if (request.method === 'GET') {
    const response = await stub.fetch('https://internal/approval/get?id=' + encodeURIComponent(id));
    if (!response.ok) return html('<!doctype html><meta charset="utf-8"><h1>Approval unavailable</h1>', response.status);
    const record = await response.json();
    if (record.ownerId !== owner.userId || record.state !== 'REQUESTED') {
      return html('<!doctype html><meta charset="utf-8"><h1>Approval is not pending</h1>', 409);
    }
    return html(approvalPage(record));
  }
  if (request.method === 'POST') {
    const form = await request.formData();
    const body = {
      ownerId: owner.userId,
      id: String(form.get('id') || ''),
      fingerprint: String(form.get('fingerprint') || ''),
      decision: String(form.get('decision') || ''),
    };
    if (body.id !== id) return html('<!doctype html><meta charset="utf-8"><h1>Approval mismatch</h1>', 400);
    const response = await stub.fetch(new Request('https://internal/approval/decide', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    if (!response.ok) return html('<!doctype html><meta charset="utf-8"><h1>Approval decision rejected</h1>', response.status);
    const result = await response.json();
    return html('<!doctype html><meta charset="utf-8"><h1>' + (result.state === 'APPROVED' ? 'Approved' : 'Denied') + '</h1><p>You can return to the MCP client.</p>');
  }
  return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } });
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
      const approvalMatch = /^\/approvals\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (approvalMatch) return handleApproval(request, env, ctx, approvalMatch[1]);
      return fallbackFetch(request, env, ctx);
    },
  };
}

export {
  handleAuthorize,
  trustedAuthorizationOwner,
};
