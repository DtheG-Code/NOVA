'use strict';
// Importiert Microsoft-Edge-Favoriten (alle Profile) inkl. Ordnerstruktur
const fs = require('node:fs');
const path = require('node:path');

let idCounter = 1;
const nextId = () => 'b' + idCounter++ + '_' + Date.now().toString(36);

function convertNode(node) {
  if (!node) return null;
  if (node.type === 'url') {
    if (!/^https?:/i.test(node.url || '')) return null;
    return { id: nextId(), type: 'url', name: node.name || node.url, url: node.url };
  }
  if (node.type === 'folder') {
    const children = (node.children || []).map(convertNode).filter(Boolean);
    return { id: nextId(), type: 'folder', name: node.name || 'Ordner', open: false, children };
  }
  return null;
}

function findEdgeProfiles() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const dir of fs.readdirSync(base)) {
    const bm = path.join(base, dir, 'Bookmarks');
    if (fs.existsSync(bm)) out.push({ profile: dir, file: bm });
  }
  return out;
}

// Liefert Wurzel-Knotenliste im Nova-Format
function importEdgeBookmarks() {
  const profiles = findEdgeProfiles();
  if (profiles.length === 0) return { ok: false, error: 'Keine Edge-Favoriten gefunden', tree: [], count: 0 };

  const tree = [];
  let count = 0;
  const countUrls = (n) => (n.type === 'url' ? 1 : (n.children || []).reduce((a, c) => a + countUrls(c), 0));

  for (const { profile, file } of profiles) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      continue;
    }
    const roots = json.roots || {};
    const sections = [
      ['bookmark_bar', 'Favoritenleiste'],
      ['other', 'Weitere Favoriten'],
      ['synced', 'Synchronisierte Favoriten'],
    ];
    const profileNodes = [];
    for (const [key, label] of sections) {
      const conv = convertNode(roots[key]);
      if (conv && conv.children.length > 0) {
        conv.name = label;
        conv.open = key === 'bookmark_bar';
        profileNodes.push(conv);
        count += countUrls(conv);
      }
    }
    if (profileNodes.length === 0) continue;
    if (profiles.length > 1) {
      tree.push({ id: nextId(), type: 'folder', name: `Edge (${profile})`, open: true, children: profileNodes });
    } else {
      tree.push(...profileNodes);
    }
  }
  return { ok: tree.length > 0, tree, count };
}

module.exports = { importEdgeBookmarks };
