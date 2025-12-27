// server/storage.js
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'tasks.json');
let cache = null;
let pending = false;
let timer = null;

function read() {
  if (cache) return cache;
  try {
    if (!fs.existsSync(FILE)) {
      cache = { tasks: [] };
      fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
      return cache;
    }
    const raw = fs.readFileSync(FILE, 'utf8');
    cache = JSON.parse(raw || '{"tasks": []}');
    if (!cache.tasks) cache.tasks = [];
    return cache;
  } catch (e) {
    console.error('Failed to read tasks.json', e);
    cache = { tasks: [] };
    return cache;
  }
}

function scheduleWrite() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(cache, null, 2));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) {
      console.error('Failed to write tasks.json', e);
    }
  }, 200);
}

function write(newData) {
  cache = newData;
  scheduleWrite();
}

module.exports = {
  read,
  write
};
