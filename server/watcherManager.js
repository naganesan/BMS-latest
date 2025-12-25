// server/watcherManager.js
// Playwright-based WatcherManager that creates an isolated context/page per task
// and provides task lifecycle management + persistence + SSE broadcasting.

const { chromium } = require('playwright');
const Watcher = require('./watcher');
const path = require('path');
const fs = require('fs');

let bookingAutomationFn = null;
try {
  const ab = require('./autoBookBMS');
  bookingAutomationFn = ab._runBookingAutomation || ab.autoBookBMS || null;
  if (typeof bookingAutomationFn !== 'function') bookingAutomationFn = null;
} catch (e) {
  bookingAutomationFn = null;
}

let Player = null;  
try { Player = require('play-sound')({}); } catch (e) { Player = null; }

function safeTaskView(task) {
  const { id, location, cinemaName, cinemaUrl, identifier, status, createdAt, href, foundHref, bookingSettings } = task;
  return {
    id, location, cinemaName, cinemaUrl, identifier, status, createdAt,
    href: href || null,
    foundHref: foundHref || null,
    bookingSettings: bookingSettings || null
  };
}

class WatcherManager {
  constructor({ maxPages = 6, pollIntervalSeconds = 5, logger = console, tasksFile = null } = {}) {
    this.maxPages = Number(maxPages) || 6;
    this.pollIntervalSeconds = Number(pollIntervalSeconds) || 5;
    this.logger = logger;

    this.browser = null;          // Playwright browser
    this.tasks = [];              // in-memory tasks
    this.sseClients = new Set();

    this.tasksFile = tasksFile ? path.resolve(tasksFile) : null;
    this._saveTimer = null;
    this._lastSavedJson = null;

    this.rotateIntervalMs = process.env.PAGE_ROTATE_MS ? Number(process.env.PAGE_ROTATE_MS) : (5 * 60 * 1000);

    this._pwLaunchArgs = [
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-plugins',
      '--remote-allow-origins=*'
    ];

    if (this.tasksFile) this._loadTasksFromFile();
  }

  async init() { return Promise.resolve(); }

  _loadTasksFromFile() {
    try {
      if (!this.tasksFile) { this.tasks = []; return; }
      if (!fs.existsSync(this.tasksFile)) {
        fs.mkdirSync(path.dirname(this.tasksFile), { recursive: true });
        fs.writeFileSync(this.tasksFile, JSON.stringify([], null, 2), 'utf8');
        this._lastSavedJson = '[]';
      }
      const raw = fs.readFileSync(this.tasksFile, 'utf8') || '[]';
      const arr = JSON.parse(raw);
      this.tasks = Array.isArray(arr) ? arr.map(t => ({ ...t, watcher: null })) : [];
      this._lastSavedJson = JSON.stringify(this.tasks.map(({ watcher, ...rest }) => rest), null, 2);
      this.logger.log(`Loaded ${this.tasks.length} tasks from ${this.tasksFile}`);

      for (const t of this.tasks) {
        if (t.status === 'running' || t.status === 'starting') {
          this._resumeTaskWatcher(t).catch(err => {
            this.logger.error(`Failed to resume watcher for ${t.id}:`, err && err.message ? err.message : err);
            t.status = 'error';
            this._saveTasksToFileImmediate();
          });
        }
      }
    } catch (e) {
      this.logger.error('Failed to load tasks file:', e && e.message ? e.message : e);
      this.tasks = [];
    }
  }

  _saveTasksToFileImmediate() {
    if (!this.tasksFile) return;
    try {
      const toSave = this.tasks.map(({ watcher, ...rest }) => rest);
      const json = JSON.stringify(toSave, null, 2);
      if (this._lastSavedJson === json) return;
      fs.writeFileSync(this.tasksFile, json, 'utf8');
      this._lastSavedJson = json;
      this.logger.log(`Saved tasks to ${this.tasksFile}`);
    } catch (e) {
      this.logger.error('Failed to save tasks file:', e && e.message ? e.message : e);
    }
  }

  _saveTasksToFile(debounceMs = 300) {
    if (!this.tasksFile) return;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveTasksToFileImmediate(), debounceMs);
  }

  // ---------- Playwright browser helpers ----------
  async _ensureBrowser() {
    if (this.browser) return this.browser;
    this.browser = await chromium.launch({
      headless: true,
      args: this._pwLaunchArgs
    });
    this.logger.log('🌐 Playwright chromium browser launched');
    return this.browser;
  }

  // create a fresh incognito context + page per task
  async _createIncognitoPageForTask(taskId, { headful = false } = {}) {
    await this._ensureBrowser();
    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
      viewport: null,
      locale: 'en-US'
    });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);
    try { await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }); } catch(_) {}

    return { page, context };
  }

  // legacy helper
  async _newPage() {
    const { page } = await this._createIncognitoPageForTask('misc');
    return page;
  }

  // SSE helpers
  addSseClient(sendFn) { this.sseClients.add(sendFn); return () => this.sseClients.delete(sendFn); }
  _broadcast(obj) {
    let safe;
    try { safe = JSON.parse(JSON.stringify(obj)); } catch (e) { safe = { type: 'error', message: 'broadcast serialization failed' }; }
    for (const s of this.sseClients) { try { s(safe); } catch (e) {} }
  }

  _playServerAlarm() {
    if (!Player) { this.logger.warn('Server alarm not available'); return; }
    const alarmFile = path.join(__dirname, '..', 'public', 'alarm.mp3');
    Player.play(alarmFile, (err) => { if (err) this.logger.error('alarm play failed:', err); else this.logger.log('🔔 server alarm played'); });
  }

  getTasks({ all = false } = {}) {
    const filtered = all ? this.tasks : this.tasks.filter(t => ['running', 'found', 'starting'].includes(t.status));
    return filtered.map(t => safeTaskView(t));
  }

  async createTask({ location, cinemaName, cinemaUrl, identifier, bookingSettings }) {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2,5)}`;
    const task = {
      id,
      location: location || null,
      cinemaName: cinemaName || null,
      cinemaUrl: cinemaUrl || null,
      identifier: String(identifier || '') || '',
      status: 'starting',
      createdAt: new Date().toISOString(),
      href: cinemaUrl || null,
      foundHref: null,
      bookingSettings: bookingSettings || null,
      watcher: null
    };

    this.tasks.push(task);
    this._saveTasksToFile();
    this._broadcast({ type: 'taskCreated', task: safeTaskView(task) });

    (async () => {
      try {
        await this._startTaskWatcher(task);
        if (!task.status || task.status === 'starting') task.status = 'running';
        this._saveTasksToFile();
        this._broadcast({ type: 'taskStarted', task: safeTaskView(task) });
      } catch (err) {
        this.logger.error(`Background watcher start failed for ${task.id}:`, err && err.message ? err.message : err);
        task.status = 'error';
        this._saveTasksToFile();
        this._broadcast({ type: 'taskError', id: task.id, message: err && err.message ? err.message : String(err) });
      }
    })();

    return id;
  }

  async stopTask(id) {
    const t = this.tasks.find(x => x.id === id);
    if (!t) { this.logger.warn(`[WatcherManager] stopTask: not found ${id}`); return false; }
    try {
      if (t.watcher) {
        try { await t.watcher.stop(); } catch (err) { this.logger.warn('stopTask watcher.stop error', err && err.message ? err.message : err); }
        t.watcher = null;
      }
      t.status = 'stopped';
      this._saveTasksToFileImmediate();
      this._broadcast({ type: 'stopped', id, task: safeTaskView(t) });
      this.logger.log(`🛑 Task ${id} stopped`);
      return true;
    } catch (e) {
      this.logger.error(`[WatcherManager] stopTask error ${id}:`, e && e.message ? e.message : e);
      t.status = 'error';
      this._saveTasksToFile();
      this._broadcast({ type: 'taskError', id, message: e && e.message ? e.message : String(e) });
      return false;
    }
  }

  async deleteTask(id) {
    const idx = this.tasks.findIndex(x => x.id === id);
    if (idx === -1) { this.logger.warn(`[WatcherManager] deleteTask: not found ${id}`); return false; }
    const t = this.tasks[idx];
    try {
      if (t.watcher) {
        try { await t.watcher.stop(); } catch (err) { this.logger.warn('deleteTask watcher.stop error', err && err.message ? err.message : err); }
        t.watcher = null;
      }
      this.tasks.splice(idx, 1);
      this._saveTasksToFileImmediate();
      this._broadcast({ type: 'deleted', id });
      this.logger.log(`🗑️ Task ${id} deleted`);
      return true;
    } catch (e) {
      this.logger.error(`[WatcherManager] deleteTask failed ${id}:`, e && e.message ? e.message : e);
      return false;
    }
  }

  async stopAllWatchers() {
    this.logger.log('[WatcherManager] stopAllWatchers: stopping all watchers now...');
    const promises = this.tasks.map(async (t) => {
      if (t.watcher) {
        try { await t.watcher.stop(); } catch (e) { this.logger.warn('stopAllWatchers individual stop failed', e && e.message ? e.message : e); }
        t.watcher = null;
        if (t.status === 'running') t.status = 'starting';
      }
    });
    await Promise.all(promises).catch(() => {});
    this._saveTasksToFileImmediate();
    this.logger.log('[WatcherManager] stopAllWatchers: done');
  }

  async restartAllWatchers({ delayBetweenStartsMs = 400 } = {}) {
    this.logger.log('[WatcherManager] restartAllWatchers: restarting active watchers...');
    const toStart = this.tasks.filter(t => ['starting', 'running', 'resumed'].includes(t.status));
    for (const t of toStart) {
      if (t.watcher) continue;
      try {
        await this._startTaskWatcher(t);
        t.status = 'running';
        this._saveTasksToFile();
        this._broadcast({ type: 'taskStarted', task: safeTaskView(t) });
      } catch (e) {
        this.logger.error('restartAllWatchers failed for', t.id, e && e.message ? e.message : e);
        t.status = 'error';
        this._saveTasksToFile();
      }
      await new Promise(r => setTimeout(r, delayBetweenStartsMs));
    }
    this.logger.log('[WatcherManager] restartAllWatchers: done');
  }

  async reloadTask(id) {
    const t = this.tasks.find(x => x.id === id);
    if (!t) return false;

    this.logger.log(`[WatcherManager] reloadTask: requested for ${id}`);
    for (const task of this.tasks) {
      if (['running', 'starting', 'resumed'].includes(task.status)) task.status = 'starting';
    }
    this._saveTasksToFile();

    try {
      await this.stopAllWatchers();
      await new Promise(r => setTimeout(r, 250));
      await this.restartAllWatchers({ delayBetweenStartsMs: 400 });
      this._broadcast({ type: 'reloaded', id, task: safeTaskView(t) });
      this.logger.log(`[WatcherManager] reloadTask: completed for ${id}`);
      return true;
    } catch (e) {
      this.logger.error(`[WatcherManager] reloadTask failed ${id}:`, e && e.message ? e.message : e);
      t.status = 'error';
      this._saveTasksToFile();
      return false;
    }
  }

  async _startTaskWatcher(task) {
    if (task.watcher) {
      try { await task.watcher.stop(); } catch (e) { this.logger.warn('existing watcher stop failed', e && e.message ? e.message : e); }
      task.watcher = null;
    }

    const watcher = new Watcher({
      id: task.id,
      cinemaUrl: task.cinemaUrl,
      identifier: task.identifier,
      pollIntervalSeconds: this.pollIntervalSeconds,
      rotateIntervalMs: this.rotateIntervalMs,
      pageFactory: (opts) => this._createIncognitoPageForTask(task.id, opts),
      logger: this.logger
    });

    task.watcher = watcher;

    await watcher.start().catch(err => {
      this.logger.error(`[WatcherManager] watcher.start error for ${task.id}:`, err && err.message ? err.message : err);
      throw err;
    });

    const monitor = setInterval(async () => {
      if (!task.watcher) { clearInterval(monitor); return; }
      if (task.watcher.found) {
        clearInterval(monitor);
        task.status = 'found';
        task.foundHref = task.watcher.foundHref || task.foundHref || null;

        if (!task.foundHref && task.watcher.page) {
          try {
            const maybe = await task.watcher.page.evaluate((identifier) => {
              try {
                const container = document.querySelector('.ReactVirtualized__Grid__innerScrollContainer') || document.body;
                const a = Array.from(container.querySelectorAll('a[href]')).find(x => (x.href || '').includes(identifier));
                return a ? a.href : null;
              } catch (e) { return null; }
            }, task.identifier).catch(() => null);
            if (maybe) task.foundHref = maybe;
          } catch (e) {}
        }

        this._saveTasksToFile();
        this.logger.log(`🔔 Task ${task.id} FOUND — ${task.identifier} => ${task.foundHref || '(unknown)'}`);

        try { this._playServerAlarm(); } catch (e) { this.logger.warn('server alarm failed', e && e.message ? e.message : e); }

        this._broadcast({ type: 'found', task: safeTaskView(task) });
        this._broadcast({ type: 'alarmStarted', id: task.id, identifier: task.identifier });

        if (bookingAutomationFn) {
          try {
            bookingAutomationFn(task).catch(err => this.logger.error('bookingAutomation failed', err && err.message ? err.message : err));
          } catch (e) {
            this.logger.error('bookingAutomation invocation error', e && e.message ? e.message : e);
          }
        }

        try { if (task.watcher) { await task.watcher.stop(); task.watcher = null; } } catch (e) {}
        return;
      }
    }, 800);
  }

  async _resumeTaskWatcher(task) {
    try {
      task.status = 'starting';
      await this._startTaskWatcher(task);
      task.status = 'running';
      this._saveTasksToFile();
      this._broadcast({ type: 'resumed', id: task.id, task: safeTaskView(task) });
    } catch (e) {
      this.logger.error('Resume watcher error for', task.id, e && e.message ? e.message : e);
      task.status = 'error';
      this._saveTasksToFile();
    }
  }

  async shutdown() {
    this.logger.log('Shutting down WatcherManager...');
    for (const t of this.tasks) {
      try { if (t.watcher) await t.watcher.stop(); } catch (e) {}
      t.status = 'stopped';
    }
    this._saveTasksToFileImmediate();
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
    }
    this.logger.log('WatcherManager shutdown complete');
  }
}

module.exports = WatcherManager;
