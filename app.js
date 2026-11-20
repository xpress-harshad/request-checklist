const select = (selector, root = document) => root.querySelector(selector);

const builder = select('[data-builder]');
if (builder) {
  const items = select('[data-items]', builder);
  const add = select('[data-add]', builder);
  const template = select('[data-item-template]', builder);
  function syncItems() {
    const fields = [...items.children];
    for (const [index, item] of fields.entries()) {
      select('legend', item).textContent = 'Item ' + (index + 1);
      select('[data-remove]', item).hidden = fields.length === 1;
    }
    add.disabled = fields.length >= 20;
  }
  add.addEventListener('click', () => {
    if (items.children.length >= 20) return;
    items.append(template.content.cloneNode(true));
    syncItems();
    select('input', items.lastElementChild).focus();
  });
  items.addEventListener('click', (event) => {
    const target = event.target.closest('[data-remove]');
    if (!target || items.children.length === 1) return;
    const item = target.closest('fieldset');
    const next = item.nextElementSibling ?? item.previousElementSibling;
    item.remove();
    syncItems();
    select('input', next).focus();
  });
  syncItems();
}

select('[data-copy]')?.addEventListener('click', async () => {
  const input = select('#share-link');
  const status = select('[data-copy-status]');
  try {
    await navigator.clipboard.writeText(input.value);
    status.textContent = 'Link copied.';
  } catch {
    input.focus();
    input.select();
    status.textContent = 'Link selected. Use your device’s copy command.';
  }
});

for (const form of document.querySelectorAll('[data-confirm]')) {
  form.addEventListener('submit', (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
}

function upload(action, file, progress) {
  const filename = file.name.toWellFormed();
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', action);
    request.responseType = 'json';
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-Upload-Name', encodeURIComponent(filename));
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) progress.value = Math.floor(100 * event.loaded / event.total);
    });
    request.addEventListener('load', () => {
      if (request.status === 201 && request.response?.count) resolve(request.response);
      else reject(new Error(request.response?.error || 'The server could not accept this file. Try again.'));
    });
    request.addEventListener('error', () => reject(new Error('The upload was interrupted. Refresh to see what arrived before trying again.')));
    request.send(file);
  });
}

const overall = select('[data-total-progress]');
function syncOverall() {
  const complete = [...document.querySelectorAll('[data-upload-item]')]
    .filter((item) => select('[data-file-count]', item).classList.contains('positive')).length;
  overall.value = complete;
  select('[data-overall]').textContent = complete + ' of ' + overall.max + ' items complete';
}

for (const form of document.querySelectorAll('[data-upload]')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const item = form.closest('[data-upload-item]');
    const limit = Number(item.dataset.limit);
    const status = select('[data-upload-status]', item);
    const input = select('input', form);
    const button = select('button', form);
    const progress = select('progress', form);
    const files = [...input.files];
    if (files.length + Number(form.dataset.count) > limit) {
      status.textContent = 'Choose up to ' + (limit - Number(form.dataset.count)) + ' remaining files.';
      return;
    }
    if (files.some((file) => !file.size || file.size > Number(form.dataset.maxBytes))) {
      status.textContent = 'Choose nonempty files within the size limit shown above.';
      return;
    }
    input.disabled = true;
    button.disabled = true;
    progress.hidden = false;
    try {
      for (const file of files) {
        progress.value = 0;
        status.textContent = 'Uploading ' + file.name + '…';
        const { count } = await upload(form.action, file, progress);
        form.dataset.count = count;
        const badge = select('[data-file-count]', item);
        badge.textContent = count + '/' + limit + ' files';
        badge.classList.toggle('positive', count >= limit);
      }
      const complete = Number(form.dataset.count) >= limit;
      form.hidden = complete;
      status.textContent = complete ? 'Received' : 'Files received. You can return to this link to finish.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      syncOverall();
      input.value = '';
      input.disabled = false;
      button.disabled = false;
      progress.hidden = true;
    }
  });
}
