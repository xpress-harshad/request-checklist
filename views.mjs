const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => escapes[char]);

const brand = '<span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 12l3 3 5-6M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg></span><strong>Request Checklist</strong>';

function page(title, body, workspace = false) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escape(title)} | Request Checklist</title>
<link rel="stylesheet" href="/style.css"><script defer src="/app.js"></script>
</head><body class="${workspace ? 'workspace' : 'simple'}">${body}</body></html>`;
}

function simple(title, body) {
  return page(title, `<header class="public-header"><div class="brand">${brand}</div></header>
    <main class="public-main">${body}</main>`);
}

export function messagePage(title, message, link = '') {
  return simple(title, `<section class="surface login"><h1>${escape(title)}</h1>
    <p>${escape(message)}</p>${link ? '<a class="button secondary" href="/admin">Back to requests</a>' : ''}</section>`);
}

export function login(error = '') {
  return simple('Workspace sign in', `<section class="surface login">
    <h1>Workspace sign in</h1><p>Sign in to create requests and view uploaded files.</p>
    <form method="post" action="/login" class="stack">
      <label>Admin password<input type="password" name="password" autocomplete="current-password" required></label>
      ${error ? `<p class="alert" role="alert">${escape(error)}</p>` : ''}
      <button>Sign in</button>
    </form></section>`);
}

const count = (items) => items.filter((item) => item.count >= item.required).length;
const formatDate = (value) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(value);

function workspace(title, selected, requests, content) {
  const entries = requests.map((request) => `<a class="request-nav" href="/admin/${request.id}" ${selected === request.id ? 'aria-current="page"' : ''}>
    <span>${escape(request.title)}</span><small>${request.completed}/${request.items} items</small></a>`).join('');
  return page(title, `<aside class="sidebar">
      <a class="brand" href="/admin">${brand}</a>
      <a class="button nav-button" href="/admin/new">New request</a>
      <nav aria-label="File requests"><h2>Your requests</h2>${entries || '<p>No requests yet.</p>'}</nav>
      <form method="post" action="/logout"><button class="text-button">Sign out</button></form>
    </aside><main class="admin-main">${content}</main>`, true);
}

export function empty(requests) {
  return workspace('File requests', '', requests, `<section class="hero">
    <h1>File requests</h1><p>Send one link and track what arrives for each item.</p></section>
    <section class="surface empty"><div class="empty-icon" aria-hidden="true">↓</div>
    <h2>Create your first request</h2><p>List the files you need. Your client can upload each one from their phone or computer.</p>
    <a class="button" href="/admin/new">New request</a></section>`);
}

function itemFields(index, item = {}) {
  return `<fieldset class="builder-item">
    <legend>Item ${index}</legend>
    <label>What should they upload?<input name="label" maxlength="90" placeholder="e.g. Product photos" value="${escape(item.label)}" required></label>
    <label>Instructions <small>(optional)</small><textarea name="details" rows="2" maxlength="260" placeholder="e.g. One photo on a plain background per product">${escape(item.details)}</textarea></label>
    <label class="quantity">Files needed<input name="required" type="number" min="1" max="12" value="${escape(item.required || 1)}" required></label>
    <button class="text-button remove-item" type="button" data-remove>Remove item</button>
  </fieldset>`;
}

export function builder(requests, copy, error = '', submitted) {
  const initial = submitted?.items?.length ? submitted.items : copy?.items || [{}];
  return workspace('New request', '', requests, `<section class="hero"><a href="/admin" class="subtle-link">All requests</a>
    <h1>New request</h1><p>Give your client a checklist they can work through at their own pace.</p></section>
    <form class="surface builder stack" method="post" action="/admin/new" data-builder>
      ${error ? `<p class="alert" role="alert">${escape(error)}</p>` : ''}
      <label>Request title<input name="title" maxlength="100" placeholder="e.g. Product launch assets" value="${escape(submitted?.title ?? copy?.title ?? '')}" required></label>
      <label>Message for the client <small>(optional)</small><textarea name="message" rows="3" maxlength="600" placeholder="Say what the files are for or when you need them.">${escape(submitted?.message ?? copy?.message ?? '')}</textarea></label>
      <div class="builder-head"><h2>Upload checklist</h2><span>Up to 20 items</span></div>
      <div class="stack" data-items>${initial.map((item, i) => itemFields(i + 1, item)).join('')}</div>
      <template data-item-template>${itemFields(1)}</template>
      <button type="button" class="secondary" data-add>Add an item</button>
      <div class="form-end"><button>Create request link</button></div>
    </form>`);
}

export function adminRequest(requests, request, publicUrl, now) {
  const finished = count(request.items);
  const open = !request.closed && request.expires > now;
  const files = request.items.reduce((sum, item) => sum + item.count, 0);
  const linkSection = open ? `<label for="share-link">Client upload link</label>
    <div class="share-row"><input id="share-link" readonly value="${escape(publicUrl)}">
      <button class="secondary" type="button" data-copy>Copy link</button></div>
    <p class="hint">Anyone with this link can upload until ${formatDate(request.expires)} (UTC). <span role="status" data-copy-status></span></p>`
    : '<h2>Uploads are closed</h2><p class="hint">You can still export the files already received.</p>';
  const entries = request.items.map((item) => `<section class="detail">
    <div class="detail-head"><div><h3>${escape(item.label)}</h3>${item.details ? `<p>${escape(item.details)}</p>` : ''}</div>
      <span class="pill ${item.count >= item.required ? 'positive' : ''}">${item.count}/${item.required} files</span></div>
    ${item.files.length ? `<ul class="filenames">${item.files.map((file) => `<li>${escape(file.filename)}</li>`).join('')}</ul>` : '<p class="hint">Waiting for files</p>'}
    </section>`).join('');
  return workspace(request.title, request.id, requests, `<section class="hero">
    <div class="detail-head"><h1>${escape(request.title)}</h1><span class="pill ${open ? 'positive' : ''}">${open ? 'Accepting uploads' : 'Closed'}</span></div>
    ${request.message ? `<p>${escape(request.message)}</p>` : ''}</section>
    <section class="surface share">${linkSection}</section>
    <section class="surface checklist">
      <div class="checklist-header detail-head"><div><h2>Upload checklist</h2>
        <p>${finished} of ${request.items.length} items complete</p></div>
        ${files ? `<a class="button" href="/admin/${request.id}/download">Download ZIP</a>` : ''}
      </div>
      <progress max="${request.items.length}" value="${finished}" aria-label="Checklist completion"></progress>
      ${entries}
    </section>
    <div class="request-actions"><a class="button secondary" href="/admin/new?copy=${request.id}">Reuse checklist</a>
      ${open ? `<form method="post" action="/admin/${request.id}/close" data-confirm="Close this upload link? People who have it will no longer be able to send files."><button class="secondary">Close upload link</button></form>` : ''}
      <form method="post" action="/admin/${request.id}/delete" data-confirm="Permanently delete this request and its uploaded files?"><button class="text-button danger">Delete request</button></form></div>`);
}

export function clientRequest(request, maxMb) {
  const finished = count(request.items);
  const entries = request.items.map((item) => `<section class="upload-card" data-upload-item data-limit="${item.required}">
    <div class="detail-head"><div><h2>${escape(item.label)}</h2>
    ${item.details ? `<p>${escape(item.details)}</p>` : ''}</div>
    <span class="pill ${item.count >= item.required ? 'positive' : ''}" data-file-count>${item.count}/${item.required} files</span></div>
    ${item.count < item.required ? `<form action="/r/${request.token}/${item.id}" data-upload data-count="${item.count}" data-max-bytes="${maxMb * 1024 * 1024}">
      <label class="file-input">Choose ${item.required - item.count === 1 ? 'a file' : 'files'} for ${escape(item.label)}
      <input type="file" ${item.required - item.count > 1 ? 'multiple' : ''} required></label>
      <button type="submit">Upload</button><progress max="100" value="0" aria-label="Current file upload" hidden></progress>
    </form>` : ''}
    <p class="upload-status" data-upload-status role="status">${item.count >= item.required ? 'Received' : ''}</p>
  </section>`).join('');
  return simple(request.title, `<section class="hero client-hero">
    <h1>${escape(request.title)}</h1><p>${escape(request.message || 'Upload the requested files below.')}</p>
    </section><section class="surface client-progress">
    <div class="detail-head"><h2>Your checklist</h2><span data-overall>${finished} of ${request.items.length} items complete</span></div>
    <progress max="${request.items.length}" value="${finished}" aria-label="Checklist completion" data-total-progress></progress>
    <p class="hint">Return to this link to finish later. Up to ${maxMb} MB per file. Uploads close ${formatDate(request.expires)} (UTC).</p></section>
    <noscript><p class="alert">Enable JavaScript to upload files.</p></noscript>
    <div class="upload-list">${entries}</div>`);
}
