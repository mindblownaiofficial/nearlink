// Updates a container to match new HTML while keeping the existing elements in place.
// Keeping the elements means focus, scroll position, pressed buttons and CSS transitions
// all survive the frequent re-renders that transfer progress causes.
(function (root) {
  const rendered = new WeakMap();

  function sameKind(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== Node.ELEMENT_NODE) return true;
    return a.nodeName === b.nodeName && (a.dataset.key || '') === (b.dataset.key || '');
  }

  function syncAttributes(from, to) {
    for (const { name } of [...from.attributes]) {
      if (!to.hasAttribute(name)) from.removeAttribute(name);
    }
    for (const { name, value } of [...to.attributes]) {
      if (from.getAttribute(name) !== value) from.setAttribute(name, value);
    }
    // Form controls keep live state apart from their attributes.
    if (from.nodeName === 'INPUT') {
      if (from.type === 'checkbox') from.checked = to.hasAttribute('checked');
      else if (document.activeElement !== from) from.value = to.getAttribute('value') || '';
    }
  }

  function syncChildren(from, to) {
    const next = [...to.childNodes];
    const current = [...from.childNodes];
    for (let i = 0; i < next.length; i++) {
      const incoming = next[i];
      const existing = current[i];
      if (!existing) {
        from.appendChild(incoming);
      } else if (!sameKind(existing, incoming)) {
        from.replaceChild(incoming, existing);
      } else if (existing.nodeType === Node.ELEMENT_NODE) {
        syncAttributes(existing, incoming);
        syncChildren(existing, incoming);
        if (existing.nodeName === 'SELECT' && document.activeElement !== existing) {
          const chosen = [...existing.options].find(option => option.hasAttribute('selected'));
          if (chosen) existing.value = chosen.value;
        }
      } else if (existing.nodeValue !== incoming.nodeValue) {
        existing.nodeValue = incoming.nodeValue;
      }
    }
    for (let i = current.length - 1; i >= next.length; i--) current[i].remove();
  }

  function morph(container, html) {
    if (rendered.get(container) === html) return;
    rendered.set(container, html);
    const template = document.createElement('template');
    template.innerHTML = html;
    syncChildren(container, template.content);
  }

  root.morph = morph;
})(globalThis);
