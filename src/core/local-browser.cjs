const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// The renderer gets opaque references, never an API that accepts arbitrary paths.
class LocalBrowser {
  constructor(home) {
    this.home = home;
    this.references = new Map();
    this.byPath = new Map();
  }
  ref(file) {
    if (this.byPath.has(file)) return this.byPath.get(file);
    if (this.references.size >= 50000) throw new Error('Restart Nearlink to reset the local browsing session.');
    const id = randomUUID();
    this.references.set(id, file);
    this.byPath.set(file, id);
    return id;
  }
  async resolve(id, directory = false) {
    const file = this.references.get(id);
    if (!file) throw new Error('Select an item in the local file browser first.');
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || (await fs.realpath(file)) !== file)
      throw new Error('This item changed or is a symbolic link. Refresh the folder.');
    if (directory && !stat.isDirectory()) throw new Error('Select a destination folder.');
    return file;
  }
  async openPath(file) {
    return this.browse(this.ref(await fs.realpath(file)));
  }
  async browse(id) {
    const folder = id ? await this.resolve(id, true) : await fs.realpath(this.home);
    const entries = [];
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) continue;
      const file = path.join(folder, item.name);
      try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) continue;
        entries.push({
          id: this.ref(file),
          name: item.name,
          directory: stat.isDirectory(),
          size: stat.size,
          modified: stat.mtimeMs,
        });
      } catch {
        /* An inaccessible/disappearing entry does not hide its siblings. */
      }
      if (entries.length > 10000) throw new Error('Choose a smaller folder (more than 10,000 items).');
    }
    const parent = path.dirname(folder);
    return {
      id: this.ref(folder),
      path: folder,
      name: path.basename(folder) || folder,
      parent: parent === folder ? null : this.ref(parent),
      entries: entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)),
    };
  }
}
module.exports = { LocalBrowser };
