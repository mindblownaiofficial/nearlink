(function (root) {
  const defaults = () => ({ view: 'list', sort: 'name', direction: 'asc', query: '' });
  const type = entry =>
    entry.directory
      ? 'Folder'
      : entry.name.includes('.')
        ? entry.name.split('.').pop().toUpperCase() + ' file'
        : 'File';
  function visible(entries, options) {
    const words = options.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    return entries
      .map((entry, index) => ({ ...entry, index }))
      .filter(e => words.every(w => e.name.toLocaleLowerCase().includes(w)))
      .sort((a, b) => {
        if (a.directory !== b.directory) return Number(b.directory) - Number(a.directory);
        let order =
          options.sort === 'size'
            ? a.directory
              ? 0
              : a.size - b.size
            : options.sort === 'modified'
              ? a.modified - b.modified
              : options.sort === 'type'
                ? compare(type(a), type(b))
                : compare(a.name, b.name);
        if (!order) order = compare(a.name, b.name);
        return options.direction === 'desc' ? -order : order;
      });
  }
  const api = { defaults, type, visible };
  if (typeof module !== 'undefined') module.exports = api;
  else root.FileView = api;
})(globalThis);
